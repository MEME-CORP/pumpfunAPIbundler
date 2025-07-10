const web3 = require('@solana/web3.js');
const bs58 = require('bs58');
const { saveKeypairToFile, loadKeypairFromFile, loadChildWalletsFromFile, saveChildWalletsToFile, getWalletBalance, getSolanaConnection, WALLETS_DIR } = require('../utils/walletUtils');
const { sendAndConfirmTransactionRobustly, sleep, calculateTransactionFee } = require('../utils/transactionUtils');
// PHASE 2: Enhanced SPL Token Balance Support
const { getTokenBalance, getAllTokenBalances, getWalletSummary, getFormattedTokenBalance, hasTokens } = require('../utils/solanaUtils');

// MONOCODE Compliance: Fix bs58 decoder compatibility issue
const bs58Decoder = bs58.default || bs58;

const MOTHER_WALLET_FILE = 'motherWallet.json';
const CHILD_WALLETS_FILE = 'childWallets.json';
// MONOCODE Compliance: More accurate fee calculation including priority fees  
const SOL_TO_LEAVE_FOR_FEES = 0.0001; // More conservative amount for transaction fees (100,000 lamports)

/**
 * Creates a new Airdrop (Mother) wallet or imports an existing one.
 * @param {string} [privateKeyBs58] - Optional base58 private key to import.
 * @returns {Promise<object>} Wallet details { publicKey, privateKey, name }.
 */
async function createOrImportMotherWalletService(privateKeyBs58) {
    let keypair;
    const walletName = "MotherAirdropWallet";
    if (privateKeyBs58) {
        try {
            const secretKey = bs58Decoder.decode(privateKeyBs58);
            if (secretKey.length !== 64) {
                throw new Error('Invalid private key length. Must be 64 bytes for a Solana keypair.');
            }
            keypair = web3.Keypair.fromSecretKey(secretKey);
            console.log(`Mother wallet imported: ${keypair.publicKey.toBase58()}`);
        } catch (error) {
            console.error('Failed to import mother wallet from private key:', error.message);
            throw new Error(`Invalid private key provided for import: ${error.message}`);
        }
    } else {
        keypair = web3.Keypair.generate();
        console.log(`New mother wallet created: ${keypair.publicKey.toBase58()}`);
    }

    // Save and return, including the private key as per user requirement for API response
    const savedWalletData = await saveKeypairToFile(keypair, MOTHER_WALLET_FILE, walletName);
    return savedWalletData; 
}


// --- Placeholder for other wallet services ---

/**
 * Creates a specified number of new Bundled (Child) Wallets.
 * One will be named DevWallet, first four after DevWallet will be "First Bundled Wallet X".
 * @param {number} count - Total number of child wallets to create (including DevWallet).
 * @param {string} devWalletName - Name for the dev wallet (e.g., "DevWallet").
 * @param {string} firstBundledWalletBaseName - Base name for the first 4 special bundled wallets (e.g., "First Bundled Wallet").
 * @returns {Promise<Array<object>>} Array of created wallet details [{ name, publicKey, privateKey }].
 */
async function createBundledWalletsService(count, devWalletName = "DevWallet", firstBundledWalletBaseName = "First Bundled Wallet") {
    if (count < 1) throw new Error('Must create at least one child wallet (for DevWallet).');
    
    const childWallets = [];
    for (let i = 0; i < count; i++) {
        const keypair = web3.Keypair.generate();
        let name;
        if (i === 0) {
            name = devWalletName;
        } else if (i >= 1 && i <= 4) {
            name = `${firstBundledWalletBaseName} ${i}`;
        } else {
            const genericIndex = i - (count > 4 ? 4 : 0); // Adjust index for generic naming
            name = `ChildWallet${genericIndex}`;
        }
        childWallets.push({ name, keypair });
    }
    console.log(`${count} child wallets generated programmatically.`);
    const savedWalletsData = await saveChildWalletsToFile(childWallets, CHILD_WALLETS_FILE);
    return savedWalletsData;
}

/**
 * Imports Bundled (Child) Wallets from an array of private keys.
 * MONOCODE Compliance: Enhanced flexibility to accept both privateKey and privateKeyBs58 field names
 * @param {Array<{name: string, privateKeyBs58?: string, privateKey?: string}>} walletImportData - Array of objects with name and privateKeyBs58 or privateKey.
 * @returns {Promise<Array<object>>} Array of imported wallet details [{ name, publicKey, privateKey }].
 */
async function importBundledWalletsService(walletImportData) {
    if (!walletImportData || walletImportData.length === 0) {
        throw new Error('No wallet data provided for import.');
    }

    const childWallets = [];
    for (const walletData of walletImportData) {
        const { name, privateKeyBs58, privateKey } = walletData;
        
        // MONOCODE Compliance: Flexible field name handling for better API compatibility
        const privateKeyValue = privateKeyBs58 || privateKey;
        
        if (!name || !privateKeyValue) {
            throw new Error('Each wallet import entry must have a name and a privateKeyBs58 (or privateKey).');
        }
        
        try {
            const secretKey = bs58Decoder.decode(privateKeyValue);
            if (secretKey.length !== 64) {
                throw new Error(`Invalid private key length for wallet ${name}. Must be 64 bytes.`);
            }
            const keypair = web3.Keypair.fromSecretKey(secretKey);
            childWallets.push({ name, keypair });
        } catch (error) {
            throw new Error(`Failed to import wallet ${name}: ${error.message}`);
        }
    }
    console.log(`${childWallets.length} child wallets imported programmatically.`);
    const savedWalletsData = await saveChildWalletsToFile(childWallets, CHILD_WALLETS_FILE);
    return savedWalletsData;
}

async function getWalletBalanceService(publicKeyString) {
    try {
        const publicKey = new web3.PublicKey(publicKeyString);
        const connection = getSolanaConnection();
        const balance = await getWalletBalance(connection, publicKey);
        if (balance === -1) throw new Error('Failed to retrieve balance.');
        return { publicKey: publicKeyString, balance };
    } catch (error) {
        console.error(`Error in getWalletBalanceService for ${publicKeyString}:`, error.message);
        throw new Error(`Invalid public key or failed to retrieve balance: ${error.message}`);
    }
}

/**
 * Funds specified child wallets from the mother wallet.
 * @param {number} amountPerWalletSOL - Amount of SOL to send to each child wallet.
 * @param {string[]} [targetWalletNames] - Optional array of child wallet names to fund. If empty/null, funds all.
 * @param {string} [motherWalletPrivateKeyBs58] - Optional private key for mother wallet if not using default.
 * @returns {Promise<Array<object>>} Array of results, each { name, publicKey, signature, status, balanceAfter }.
 */
async function fundChildWalletsService(amountPerWalletSOL, targetWalletNames, motherWalletPrivateKeyBs58) {
    const connection = getSolanaConnection();
    let motherWallet;
    if (motherWalletPrivateKeyBs58) {
        try {
            const secretKey = bs58Decoder.decode(motherWalletPrivateKeyBs58);
            motherWallet = web3.Keypair.fromSecretKey(secretKey);
        } catch (e) {
            throw new Error('Invalid mother wallet private key for funding.');
        }
    } else {
        const loadedMother = await loadKeypairFromFile(MOTHER_WALLET_FILE);
        if (!loadedMother) throw new Error('Mother wallet not found. Please create or import it first.');
        motherWallet = loadedMother.keypair;
    }

    const motherBalance = await getWalletBalance(connection, motherWallet.publicKey);
    console.log(`Mother wallet ${motherWallet.publicKey.toBase58()} balance: ${motherBalance} SOL`);

    let allChildWallets = await loadChildWalletsFromFile(CHILD_WALLETS_FILE);
    if (!allChildWallets || allChildWallets.length === 0) {
        throw new Error('No child wallets found. Please create them first.');
    }

    const walletsToFund = targetWalletNames && targetWalletNames.length > 0
        ? allChildWallets.filter(cw => targetWalletNames.includes(cw.name))
        : allChildWallets;

    if (walletsToFund.length === 0) {
        throw new Error('No matching child wallets to fund based on provided names.');
    }

    const lamportsToSend = amountPerWalletSOL * web3.LAMPORTS_PER_SOL;
    
    // MONOCODE Compliance: More accurate fee calculation
    const estimatedFeePerTx = calculateTransactionFee(100000, 200000);
    const estimatedFeeSOLPerTx = estimatedFeePerTx / web3.LAMPORTS_PER_SOL;
    const totalFees = estimatedFeeSOLPerTx * walletsToFund.length * 1.2; // 20% buffer
    const totalSOLNeeded = (amountPerWalletSOL * walletsToFund.length) + totalFees;
    
    console.log(`[WalletService] Fund calculation: ${amountPerWalletSOL} SOL x ${walletsToFund.length} wallets + ${totalFees.toFixed(6)} SOL fees = ${totalSOLNeeded.toFixed(6)} SOL total`);
    
    if (motherBalance < totalSOLNeeded) {
        throw new Error(`Insufficient SOL in mother wallet. Needs ${totalSOLNeeded.toFixed(6)} SOL (${(amountPerWalletSOL * walletsToFund.length).toFixed(6)} for transfers + ${totalFees.toFixed(6)} for fees), has ${motherBalance.toFixed(6)} SOL.`);
    }

    const results = [];
    for (const child of walletsToFund) {
        console.log(`Funding ${child.name} (${child.publicKey}) with ${amountPerWalletSOL} SOL...`);
        const transaction = new web3.Transaction().add(
            web3.SystemProgram.transfer({
                fromPubkey: motherWallet.publicKey,
                toPubkey: new web3.PublicKey(child.publicKey),
                lamports: lamportsToSend,
            })
        );
        try {
            const signature = await sendAndConfirmTransactionRobustly(connection, transaction, [motherWallet], { 
                skipPreflight: true,
                priorityFeeMicrolamports: 100000,
                computeUnitLimit: 200000,
                commitment: 'confirmed'
            });
            const balanceAfter = await getWalletBalance(connection, new web3.PublicKey(child.publicKey));
            results.push({ 
                name: child.name, 
                publicKey: child.publicKey, 
                signature, 
                status: 'success', 
                amountSent: amountPerWalletSOL,
                balanceAfter 
            });
            console.log(`Successfully funded ${child.name}. New balance: ${balanceAfter} SOL. Tx: ${signature}`);
            if (walletsToFund.indexOf(child) < walletsToFund.length - 1) await sleep(1000); // Short delay between txs
        } catch (error) {
            console.error(`Failed to fund ${child.name}: ${error.message}`);
            results.push({ name: child.name, publicKey: child.publicKey, status: 'failed', error: error.message, amountSent: amountPerWalletSOL });
        }
    }
    return results;
}

/**
 * Returns SOL from specified child wallets to the mother wallet.
 * @param {string} motherWalletPublicKeyBs58 - Public key of the mother wallet to receive funds.
 * @param {string[]} [sourceWalletNames] - Optional array of child wallet names to return funds from. If empty/null, returns from all.
 * @returns {Promise<Array<object>>} Array of results, each { name, publicKey, signature, status, balanceAfter, amountReturned }.
 */
async function returnFundsToMotherWalletService(motherWalletPublicKeyBs58, sourceWalletNames) {
    const connection = getSolanaConnection();
    const motherPublicKey = new web3.PublicKey(motherWalletPublicKeyBs58);

    let allChildWallets = await loadChildWalletsFromFile(CHILD_WALLETS_FILE);
    if (!allChildWallets || allChildWallets.length === 0) {
        throw new Error('No child wallets found to return funds from.');
    }

    const walletsToReturnFrom = sourceWalletNames && sourceWalletNames.length > 0
        ? allChildWallets.filter(cw => sourceWalletNames.includes(cw.name))
        : allChildWallets;

    if (walletsToReturnFrom.length === 0) {
        throw new Error('No matching child wallets to return funds from based on provided names.');
    }

    const results = [];
    for (const child of walletsToReturnFrom) {
        const childKeypair = child.keypair;
        const childPublicKey = new web3.PublicKey(child.publicKey);
        let amountToReturnLamports = 0;
        let status = 'failed';
        let signature = null;
        let errorMsg = null;
        let balanceBefore = 0;

        try {
            balanceBefore = await getWalletBalance(connection, childPublicKey);
            
            // MONOCODE Compliance: Calculate accurate transaction fees including priority fees
            const estimatedFee = calculateTransactionFee(100000, 200000); // Priority fee + compute units
            const estimatedFeeSOL = estimatedFee / web3.LAMPORTS_PER_SOL;
            const totalFeeReserve = Math.max(SOL_TO_LEAVE_FOR_FEES, estimatedFeeSOL * 1.5); // 50% buffer
            
            console.log(`${child.name} balance: ${balanceBefore} SOL, estimated fee: ${estimatedFeeSOL} SOL, reserve: ${totalFeeReserve} SOL`);
            
            if (balanceBefore <= totalFeeReserve) {
                console.log(`${child.name} (${child.publicKey}) has insufficient balance (${balanceBefore} SOL) to cover fees (${totalFeeReserve} SOL). Skipping.`);
                results.push({ name: child.name, publicKey: child.publicKey, status: 'skipped_low_balance', amountReturned: 0, balanceAfter: balanceBefore });
                continue;
            }
            
            amountToReturnLamports = Math.floor((balanceBefore - totalFeeReserve) * web3.LAMPORTS_PER_SOL);
            
            if (amountToReturnLamports <= 0) {
                 console.log(`${child.name} (${child.publicKey}) balance after leaving fees is too low (${amountToReturnLamports} lamports). Skipping.`);
                 results.push({ name: child.name, publicKey: child.publicKey, status: 'skipped_low_after_fees', amountReturned: 0, balanceAfter: balanceBefore });
                 continue;
            }

            console.log(`Returning ${amountToReturnLamports / web3.LAMPORTS_PER_SOL} SOL from ${child.name} (${child.publicKey}) to ${motherPublicKey.toBase58()}...`);
            const transaction = new web3.Transaction().add(
                web3.SystemProgram.transfer({
                    fromPubkey: childPublicKey,
                    toPubkey: motherPublicKey,
                    lamports: amountToReturnLamports,
                })
            );
            signature = await sendAndConfirmTransactionRobustly(connection, transaction, [childKeypair], { 
                skipPreflight: true,
                priorityFeeMicrolamports: 100000,
                computeUnitLimit: 200000,
                commitment: 'confirmed'
            });
            status = 'success';
            console.log(`Successfully returned SOL from ${child.name}. Tx: ${signature}`);
        } catch (error) {
            console.error(`Failed to return funds from ${child.name}: ${error.message}`);
            errorMsg = error.message;
        }
        const balanceAfter = await getWalletBalance(connection, childPublicKey);
        results.push({
            name: child.name,
            publicKey: child.publicKey,
            signature,
            status,
            error: errorMsg,
            amountReturned: status === 'success' ? amountToReturnLamports / web3.LAMPORTS_PER_SOL : 0,
            balanceBefore,
            balanceAfter
        });
        if (walletsToReturnFrom.indexOf(child) < walletsToReturnFrom.length - 1) await sleep(1000); // Short delay
    }
    return results;
}

// ============================================================================
// PHASE 2: ENHANCED SPL TOKEN BALANCE SERVICES
// ============================================================================

/**
 * Gets SPL token balance for a specific mint address.
 * MONOCODE Compliance: Explicit error handling with structured responses
 * @param {string} publicKeyString - The wallet's public key as string
 * @param {string} mintAddress - The token mint address as string
 * @returns {Promise<object>} Token balance info with error handling
 */
async function getTokenBalanceService(publicKeyString, mintAddress) {
    console.log(`[WalletService] Getting token balance for wallet: ${publicKeyString.slice(0, 8)}..., mint: ${mintAddress.slice(0, 8)}...`);
    
    try {
        // Input validation
        if (!publicKeyString || !mintAddress) {
            throw new Error('Both publicKey and mintAddress are required');
        }
        
        // Validate public key format
        try {
            new web3.PublicKey(publicKeyString);
        } catch (error) {
            throw new Error(`Invalid public key format: ${error.message}`);
        }
        
        // Validate mint address format
        try {
            new web3.PublicKey(mintAddress);
        } catch (error) {
            throw new Error(`Invalid mint address format: ${error.message}`);
        }
        
        const tokenInfo = await getTokenBalance(publicKeyString, mintAddress);
        
        // Enhanced response with additional metadata
        const response = {
            publicKey: publicKeyString,
            mint: mintAddress,
            balance: tokenInfo.balance,
            decimals: tokenInfo.decimals,
            uiAmount: tokenInfo.balance / Math.pow(10, tokenInfo.decimals),
            timestamp: new Date().toISOString(),
            status: 'success'
        };
        
        // Include error if present but still return data
        if (tokenInfo.error) {
            response.warning = tokenInfo.error;
            response.status = 'partial_success';
        }
        
        console.log(`[WalletService] ✅ Token balance retrieved: ${response.uiAmount} UI units`);
        return response;
        
    } catch (error) {
        console.error(`[WalletService] ❌ Error in getTokenBalanceService: ${error.message}`);
        
        // Structured error response following MONOCODE Explicit Error Handling
        return {
            publicKey: publicKeyString,
            mint: mintAddress,
            balance: 0,
            decimals: 0,
            uiAmount: 0,
            timestamp: new Date().toISOString(),
            status: 'error',
            error: error.message
        };
    }
}

/**
 * Gets all SPL token balances for a wallet.
 * MONOCODE Compliance: Observable implementation with performance tracking
 * @param {string} publicKeyString - The wallet's public key as string
 * @returns {Promise<object>} All token balances with metadata
 */
async function getAllTokenBalancesService(publicKeyString) {
    console.log(`[WalletService] Getting all token balances for wallet: ${publicKeyString.slice(0, 8)}...`);
    const startTime = Date.now();
    
    try {
        // Input validation
        if (!publicKeyString) {
            throw new Error('publicKey is required');
        }
        
        // Validate public key format
        try {
            new web3.PublicKey(publicKeyString);
        } catch (error) {
            throw new Error(`Invalid public key format: ${error.message}`);
        }
        
        const [tokenBalances, tokenCheck] = await Promise.all([
            getAllTokenBalances(publicKeyString),
            hasTokens(publicKeyString)
        ]);
        
        // Enhanced response with performance metrics
        const duration = Date.now() - startTime;
        const response = {
            publicKey: publicKeyString,
            tokens: tokenBalances.map(token => ({
                mint: token.mint,
                balance: token.balance,
                decimals: token.decimals,
                uiAmount: token.balance / Math.pow(10, token.decimals)
            })),
            summary: {
                tokenCount: tokenBalances.length,
                hasTokens: tokenCheck.hasTokens,
                totalTokenAccounts: tokenCheck.tokenCount
            },
            performance: {
                queryDuration: duration,
                timestamp: new Date().toISOString()
            },
            status: 'success'
        };
        
        console.log(`[WalletService] ✅ All token balances retrieved: ${tokenBalances.length} tokens in ${duration}ms`);
        return response;
        
    } catch (error) {
        console.error(`[WalletService] ❌ Error in getAllTokenBalancesService: ${error.message}`);
        
        // Graceful fallback response
        const duration = Date.now() - startTime;
        return {
            publicKey: publicKeyString,
            tokens: [],
            summary: {
                tokenCount: 0,
                hasTokens: false,
                totalTokenAccounts: 0
            },
            performance: {
                queryDuration: duration,
                timestamp: new Date().toISOString()
            },
            status: 'error',
            error: error.message
        };
    }
}

/**
 * Gets complete wallet summary including SOL and all SPL tokens.
 * MONOCODE Compliance: Progressive construction with comprehensive data
 * @param {string} publicKeyString - The wallet's public key as string
 * @returns {Promise<object>} Complete wallet summary with enhanced metadata
 */
async function getWalletSummaryService(publicKeyString) {
    console.log(`[WalletService] Getting complete wallet summary for: ${publicKeyString.slice(0, 8)}...`);
    const startTime = Date.now();
    
    try {
        // Input validation
        if (!publicKeyString) {
            throw new Error('publicKey is required');
        }
        
        // Validate public key format
        try {
            new web3.PublicKey(publicKeyString);
        } catch (error) {
            throw new Error(`Invalid public key format: ${error.message}`);
        }
        
        const walletSummary = await getWalletSummary(publicKeyString);
        
        // Enhanced response with additional service-layer metadata
        const duration = Date.now() - startTime;
        const response = {
            publicKey: publicKeyString,
            sol: {
                balance: walletSummary.sol.balance,
                lamports: walletSummary.sol.lamports,
                usdValue: null // Placeholder for future price integration
            },
            tokens: walletSummary.tokens.map(token => ({
                mint: token.mint,
                balance: token.balance,
                decimals: token.decimals,
                uiAmount: token.balance / Math.pow(10, token.decimals),
                symbol: token.symbol || null, // Placeholder for future symbol lookup
                usdValue: null // Placeholder for future price integration
            })),
            summary: {
                totalAssets: 1 + walletSummary.tokens.length, // SOL + tokens
                solBalance: walletSummary.sol.balance,
                tokenCount: walletSummary.tokens.length,
                hasTokens: walletSummary.tokens.length > 0,
                lastUpdated: walletSummary.timestamp
            },
            performance: {
                queryDuration: duration,
                timestamp: new Date().toISOString()
            },
            status: 'success'
        };
        
        // Include error information if present in wallet summary
        if (walletSummary.error) {
            response.warning = walletSummary.error;
            response.status = 'partial_success';
        }
        
        console.log(`[WalletService] ✅ Complete wallet summary: ${response.sol.balance} SOL, ${response.tokens.length} tokens in ${duration}ms`);
        return response;
        
    } catch (error) {
        console.error(`[WalletService] ❌ Error in getWalletSummaryService: ${error.message}`);
        
        // Comprehensive fallback response
        const duration = Date.now() - startTime;
        return {
            publicKey: publicKeyString,
            sol: {
                balance: 0,
                lamports: 0,
                usdValue: null
            },
            tokens: [],
            summary: {
                totalAssets: 0,
                solBalance: 0,
                tokenCount: 0,
                hasTokens: false,
                lastUpdated: new Date().toISOString()
            },
            performance: {
                queryDuration: duration,
                timestamp: new Date().toISOString()
            },
            status: 'error',
            error: error.message
        };
    }
}

/**
 * Gets formatted token balance with UI-ready values.
 * MONOCODE Compliance: Dependency transparency with clear formatting
 * @param {string} publicKeyString - The wallet's public key as string
 * @param {string} mintAddress - The token mint address as string
 * @returns {Promise<object>} Formatted token balance info
 */
async function getFormattedTokenBalanceService(publicKeyString, mintAddress) {
    console.log(`[WalletService] Getting formatted token balance for mint: ${mintAddress.slice(0, 8)}...`);
    
    try {
        // Input validation
        if (!publicKeyString || !mintAddress) {
            throw new Error('Both publicKey and mintAddress are required');
        }
        
        const formattedBalance = await getFormattedTokenBalance(publicKeyString, mintAddress);
        
        const response = {
            publicKey: publicKeyString,
            mint: mintAddress,
            rawBalance: formattedBalance.rawBalance,
            uiAmount: formattedBalance.uiAmount,
            decimals: formattedBalance.decimals,
            formatted: {
                display: formattedBalance.uiAmount.toFixed(formattedBalance.decimals),
                scientific: formattedBalance.uiAmount.toExponential(3),
                compact: formattedBalance.uiAmount < 1000 ? 
                    formattedBalance.uiAmount.toFixed(2) : 
                    `${(formattedBalance.uiAmount / 1000).toFixed(1)}k`
            },
            timestamp: new Date().toISOString(),
            status: 'success'
        };
        
        // Include error if present
        if (formattedBalance.error) {
            response.warning = formattedBalance.error;
            response.status = 'partial_success';
        }
        
        console.log(`[WalletService] ✅ Formatted token balance: ${response.uiAmount} UI units`);
        return response;
        
    } catch (error) {
        console.error(`[WalletService] ❌ Error in getFormattedTokenBalanceService: ${error.message}`);
        
        return {
            publicKey: publicKeyString,
            mint: mintAddress,
            rawBalance: 0,
            uiAmount: 0,
            decimals: 0,
            formatted: {
                display: '0.00',
                scientific: '0.000e+0',
                compact: '0.00'
            },
            timestamp: new Date().toISOString(),
            status: 'error',
            error: error.message
        };
    }
}


module.exports = {
    // Existing services (backward compatibility maintained)
    createOrImportMotherWalletService,
    createBundledWalletsService,
    importBundledWalletsService,
    getWalletBalanceService, // Original SOL balance service
    fundChildWalletsService,
    returnFundsToMotherWalletService,
    
    // PHASE 2: Enhanced SPL Token Balance Services
    getTokenBalanceService,
    getAllTokenBalancesService,
    getWalletSummaryService,
    getFormattedTokenBalanceService
}; 
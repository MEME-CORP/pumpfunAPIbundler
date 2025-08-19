const web3 = require('@solana/web3.js');
const bs58 = require('bs58');
const { saveKeypairToFile, loadKeypairFromFile, loadChildWalletsFromFile, saveChildWalletsToFile, getWalletBalance, getSolanaConnection, WALLETS_DIR } = require('../utils/walletUtils');
const { sendAndConfirmTransactionRobustly, sleep, calculateTransactionFee, calculateTransactionCostWithRent, validateBalanceForRentOperations, getRentExemptionForAccountType } = require('../utils/transactionUtils');
// PHASE 2: Enhanced SPL Token Balance Support
const { getTokenBalance, getAllTokenBalances, getBatchedTokenBalances, getWalletSummary, getFormattedTokenBalance, hasTokens } = require('../utils/solanaUtils');

// MONOCODE Compliance: Fix bs58 decoder compatibility issue
const bs58Decoder = bs58.default || bs58;

// MONOCODE Enhancement: Intelligent batching coordinator for balance requests
const pendingBalanceRequests = new Map(); // mint -> { requests: Array, timeout: NodeJS.Timeout }
const BATCH_THRESHOLD = 4; // Minimum requests to trigger batching
const BATCH_WINDOW_MS = 1000; // Time window to accumulate requests

const MOTHER_WALLET_FILE = 'motherWallet.json';
const CHILD_WALLETS_FILE = 'childWallets.json';
// MONOCODE Compliance: More accurate fee calculation including priority fees  
const SOL_TO_LEAVE_FOR_FEES = 0.0001; // More conservative amount for transaction fees (100,000 lamports)

/**
 * Creates a new Airdrop (Mother) wallet or imports an existing one.
 * MONOCODE Compliance: Stateless operation - no file system dependencies for API compatibility
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

    // MONOCODE Fix: Return wallet data directly without file storage for stateless operation
    const walletData = {
        publicKey: keypair.publicKey.toBase58(),
        privateKey: bs58Decoder.encode(keypair.secretKey), // Return as base58 for API compatibility
        name: walletName
    };
    
    console.log(`[WalletService] ${privateKeyBs58 ? 'Imported' : 'Created'} wallet (stateless): ${walletData.publicKey}`);
    return walletData; 
}


// --- Placeholder for other wallet services ---

/**
 * Creates a specified number of new Bundled (Child) Wallets.
 * One will be named DevWallet, first four after DevWallet will be "First Bundled Wallet X".
 * MONOCODE Compliance: Stateless operation - no file system dependencies
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
    
    // MONOCODE Fix: Return wallet data directly without file storage for stateless operation
    const walletsData = childWallets.map(wallet => ({
        name: wallet.name,
        publicKey: wallet.keypair.publicKey.toBase58(),
        privateKey: bs58Decoder.encode(wallet.keypair.secretKey), // Return as base58 for API compatibility
    }));
    
    console.log(`[WalletService] Created ${walletsData.length} bundled wallets (stateless)`);
    return walletsData;
}

/**
 * Imports Bundled (Child) Wallets from an array of private keys.
 * MONOCODE Compliance: Enhanced flexibility to accept both privateKey and privateKeyBs58 field names + Stateless operation
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
    
    // MONOCODE Fix: Return wallet data directly without file storage for stateless operation
    const walletsData = childWallets.map(wallet => ({
        name: wallet.name,
        publicKey: wallet.keypair.publicKey.toBase58(),
        privateKey: bs58Decoder.encode(wallet.keypair.secretKey), // Return as base58 for API compatibility
    }));
    
    console.log(`[WalletService] Imported ${walletsData.length} bundled wallets (stateless)`);
    return walletsData;
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
 * MONOCODE Compliance: Stateless operation - wallets provided via API request
 * @param {number} amountPerWalletSOL - Amount of SOL to send to each child wallet.
 * @param {Array<{name: string, privateKey: string, privateKeyBs58?: string}>} childWallets - Array of child wallet objects with private keys.
 * @param {string} motherWalletPrivateKeyBs58 - Required private key for mother wallet (base58 encoded).
 * @param {string[]} [targetWalletNames] - Optional array of child wallet names to fund. If empty/null, funds all.
 * @returns {Promise<Array<object>>} Array of results, each { name, publicKey, signature, status, balanceAfter }.
 */
async function fundChildWalletsService(amountPerWalletSOL, childWallets, motherWalletPrivateKeyBs58, targetWalletNames) {
    const connection = getSolanaConnection();
    
    // MONOCODE Fix: Require mother wallet private key for stateless operation
    if (!motherWalletPrivateKeyBs58) {
        throw new Error('Mother wallet private key is required for stateless funding operation.');
    }
    
    let motherWallet;
        try {
        const secretKey = bs58Decoder.decode(motherWalletPrivateKeyBs58);
            motherWallet = web3.Keypair.fromSecretKey(secretKey);
        } catch (e) {
            throw new Error('Invalid mother wallet private key for funding.');
    }

    const motherBalance = await getWalletBalance(connection, motherWallet.publicKey);
    console.log(`Mother wallet ${motherWallet.publicKey.toBase58()} balance: ${motherBalance} SOL`);

    // MONOCODE Fix: Use provided child wallets instead of loading from file
    if (!childWallets || childWallets.length === 0) {
        throw new Error('No child wallets provided in the request.');
    }
    
    // Convert provided child wallets to keypair objects
    const allChildWallets = [];
    for (const walletData of childWallets) {
        const { name, privateKey, privateKeyBs58 } = walletData;
        const privateKeyValue = privateKey || privateKeyBs58;
        
        if (!name || !privateKeyValue) {
            throw new Error(`Each child wallet must have a name and privateKey. Missing for wallet: ${JSON.stringify(walletData)}`);
        }
        
        try {
            const secretKey = bs58Decoder.decode(privateKeyValue);
            const keypair = web3.Keypair.fromSecretKey(secretKey);
            allChildWallets.push({
                name: name,
                publicKey: keypair.publicKey.toBase58(),
                keypair: keypair
            });
        } catch (error) {
            throw new Error(`Failed to decode private key for wallet ${name}: ${error.message}`);
    }
    }
    
    console.log(`[WalletService] Loaded ${allChildWallets.length} child wallets from API request`);

    const walletsToFund = targetWalletNames && targetWalletNames.length > 0
        ? allChildWallets.filter(cw => targetWalletNames.includes(cw.name))
        : allChildWallets;

    if (walletsToFund.length === 0) {
        throw new Error('No matching child wallets to fund based on provided names.');
    }

    const lamportsToSend = amountPerWalletSOL * web3.LAMPORTS_PER_SOL;
    
    // MONOCODE Compliance: Enhanced fee calculation including rent exemption requirements
    // Calculate costs for transfer transactions, accounting for future token operations
    const costPerTransaction = calculateTransactionCostWithRent({
        priorityFeeMicrolamports: 200000,
        computeUnitLimit: 300000,
        accountTypesToCreate: ['token'], // Account for potential future token account creation
        includeRentBuffer: true // Include rent exemption requirements
    });
    
    const totalFees = costPerTransaction.summary.transactionFeeSOL * walletsToFund.length * 1.2; // 20% buffer
    const totalSOLNeeded = (amountPerWalletSOL * walletsToFund.length) + totalFees;
    
    console.log(`[WalletService] Fund calculation: ${amountPerWalletSOL} SOL x ${walletsToFund.length} wallets + ${totalFees.toFixed(6)} SOL fees = ${totalSOLNeeded.toFixed(6)} SOL total`);
    console.log(`[WalletService] Note: Each recipient will maintain ${costPerTransaction.summary.totalRentRequiredSOL.toFixed(8)} SOL rent exemption + ${costPerTransaction.summary.rentBufferSOL.toFixed(8)} SOL buffer for token operations`);
    
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
                priorityFeeMicrolamports: 200000,
                computeUnitLimit: 300000,
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
 * MONOCODE Compliance: Stateless operation - wallets provided via API request
 * @param {Array<{name: string, privateKey: string, privateKeyBs58?: string}>} childWallets - Array of child wallet objects with private keys.
 * @param {string} motherWalletPublicKeyBs58 - Public key of the mother wallet to receive funds.
 * @param {string[]} [sourceWalletNames] - Optional array of child wallet names to return funds from. If empty/null, returns from all.
 * @returns {Promise<Array<object>>} Array of results, each { name, publicKey, signature, status, balanceAfter, amountReturned }.
 */
async function returnFundsToMotherWalletService(childWallets, motherWalletPublicKeyBs58, sourceWalletNames) {
    const connection = getSolanaConnection();
    const motherPublicKey = new web3.PublicKey(motherWalletPublicKeyBs58);

    // MONOCODE Fix: Use provided child wallets instead of loading from file
    if (!childWallets || childWallets.length === 0) {
        throw new Error('No child wallets provided in the request.');
    }
    
    // Convert provided child wallets to keypair objects
    const allChildWallets = [];
    for (const walletData of childWallets) {
        const { name, privateKey, privateKeyBs58 } = walletData;
        const privateKeyValue = privateKey || privateKeyBs58;
        
        if (!name || !privateKeyValue) {
            throw new Error(`Each child wallet must have a name and privateKey. Missing for wallet: ${JSON.stringify(walletData)}`);
        }
        
        try {
            const secretKey = bs58Decoder.decode(privateKeyValue);
            const keypair = web3.Keypair.fromSecretKey(secretKey);
            allChildWallets.push({
                name: name,
                publicKey: keypair.publicKey.toBase58(),
                keypair: keypair
            });
        } catch (error) {
            throw new Error(`Failed to decode private key for wallet ${name}: ${error.message}`);
        }
    }
    
    console.log(`[WalletService] Loaded ${allChildWallets.length} child wallets for return funds operation`);

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
            
            // MONOCODE Compliance: Calculate accurate transaction fees INCLUDING rent exemption requirements
            // For return funds, we need to account for future token operations that may require rent exemption
            const costCalculation = calculateTransactionCostWithRent({
                priorityFeeMicrolamports: 200000,
                computeUnitLimit: 300000,
                accountTypesToCreate: ['token'], // Account for potential future token account creation
                includeRentBuffer: true // Include rent exemption requirements
            });
            
            const estimatedFeeSOL = costCalculation.summary.transactionFeeSOL;
            const rentExemptionSOL = costCalculation.summary.totalRentRequiredSOL;
            const rentBufferSOL = costCalculation.summary.rentBufferSOL;
            const totalReserveNeeded = Math.max(SOL_TO_LEAVE_FOR_FEES, estimatedFeeSOL + rentExemptionSOL + rentBufferSOL);
            
            console.log(`${child.name} balance: ${balanceBefore} SOL, fee: ${estimatedFeeSOL} SOL, rent exemption: ${rentExemptionSOL} SOL, buffer: ${rentBufferSOL} SOL, total reserve: ${totalReserveNeeded} SOL`);
            
            if (balanceBefore <= totalReserveNeeded) {
                console.log(`${child.name} (${child.publicKey}) has insufficient balance (${balanceBefore} SOL) to cover fees and rent exemption (${totalReserveNeeded} SOL). Skipping.`);
                results.push({ name: child.name, publicKey: child.publicKey, status: 'skipped_low_balance', amountReturned: 0, balanceAfter: balanceBefore });
                continue;
            }
            
            amountToReturnLamports = Math.floor((balanceBefore - totalReserveNeeded) * web3.LAMPORTS_PER_SOL);
            
            if (amountToReturnLamports <= 0) {
                 console.log(`${child.name} (${child.publicKey}) balance after leaving fees and rent exemption is too low (${amountToReturnLamports} lamports). Skipping.`);
                 results.push({ name: child.name, publicKey: child.publicKey, status: 'skipped_low_after_reserves', amountReturned: 0, balanceAfter: balanceBefore });
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
                priorityFeeMicrolamports: 200000,
                computeUnitLimit: 300000,
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
 * Intelligent batching coordinator for token balance requests
 * MONOCODE Compliance: Observable implementation with automatic optimization
 * @param {string} publicKeyString - The wallet's public key as string
 * @param {string} mintAddress - The token mint address as string
 * @returns {Promise<object>} Token balance info with batching optimization
 */
async function getTokenBalanceWithIntelligentBatching(publicKeyString, mintAddress) {
    return new Promise((resolve, reject) => {
        const requestKey = mintAddress;
        const request = { publicKeyString, mintAddress, resolve, reject };
        
        if (!pendingBalanceRequests.has(requestKey)) {
            // First request for this mint - start accumulation window
            pendingBalanceRequests.set(requestKey, {
                requests: [request],
                timeout: setTimeout(async () => {
                    const batch = pendingBalanceRequests.get(requestKey);
                    pendingBalanceRequests.delete(requestKey);
                    
                    if (batch.requests.length >= BATCH_THRESHOLD) {
                        // Use batched processing
                        console.log(`[WalletService] 🚀 Batching ${batch.requests.length} balance requests for mint: ${mintAddress.slice(0, 8)}...`);
                        await processBatchedBalanceRequests(batch.requests, mintAddress);
                    } else {
                        // Process individually
                        console.log(`[WalletService] Processing ${batch.requests.length} individual balance requests for mint: ${mintAddress.slice(0, 8)}...`);
                        await processIndividualBalanceRequests(batch.requests, mintAddress);
                    }
                }, BATCH_WINDOW_MS)
            });
        } else {
            // Add to existing batch
            pendingBalanceRequests.get(requestKey).requests.push(request);
        }
    });
}

/**
 * Processes balance requests using batched RPC calls
 * @param {Array} requests - Array of request objects
 * @param {string} mintAddress - The token mint address
 */
async function processBatchedBalanceRequests(requests, mintAddress) {
    try {
        const walletPublicKeys = requests.map(req => req.publicKeyString);
        const connection = getSolanaConnection();
        
        // Dynamic batch size based on RPC type
        const batchSize = process.env.SOLANA_RPC_URL && !process.env.SOLANA_RPC_URL.includes('api.mainnet-beta.solana.com') ? 8 : 4;
        const batchResults = await getBatchedTokenBalances(walletPublicKeys, mintAddress, connection, batchSize);
        
        // Map results back to individual requests
        requests.forEach((request, index) => {
            const result = batchResults[index];
            const response = {
                publicKey: request.publicKeyString,
                mint: mintAddress,
                balance: result.balance,
                decimals: result.decimals,
                uiAmount: result.balance / Math.pow(10, result.decimals),
                timestamp: new Date().toISOString(),
                status: 'success',
                batched: true // Indicate this was processed in batch
            };
            request.resolve(response);
        });
        
        console.log(`[WalletService] ✅ Batched balance processing complete: ${requests.length} wallets`);
    } catch (error) {
        console.error(`[WalletService] ❌ Batch processing error: ${error.message}`);
        // Fallback to individual processing on batch failure
        await processIndividualBalanceRequests(requests, mintAddress);
    }
}

/**
 * Processes balance requests individually as fallback
 * @param {Array} requests - Array of request objects
 * @param {string} mintAddress - The token mint address
 */
async function processIndividualBalanceRequests(requests, mintAddress) {
    for (const request of requests) {
        try {
            const tokenInfo = await getTokenBalance(request.publicKeyString, mintAddress);
            const response = {
                publicKey: request.publicKeyString,
                mint: mintAddress,
                balance: tokenInfo.balance,
                decimals: tokenInfo.decimals,
                uiAmount: tokenInfo.balance / Math.pow(10, tokenInfo.decimals),
                timestamp: new Date().toISOString(),
                status: 'success',
                batched: false
            };
            
            if (tokenInfo.error) {
                response.warning = tokenInfo.error;
                response.status = 'partial_success';
            }
            
            request.resolve(response);
        } catch (error) {
            request.reject(error);
        }
    }
}

/**
 * Gets SPL token balance for a specific mint address.
 * MONOCODE Compliance: Enhanced with intelligent batching while maintaining API compatibility
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
        
        // Use intelligent batching coordinator
        const response = await getTokenBalanceWithIntelligentBatching(publicKeyString, mintAddress);
        
        console.log(`[WalletService] ✅ Token balance retrieved: ${response.uiAmount} UI units${response.batched ? ' (batched)' : ''}`);
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
            error: error.message,
            batched: false
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


/**
 * Validates wallet balances for operations that may create token accounts
 * MONOCODE Compliance: Enhanced balance validation with rent exemption requirements
 * @param {Array<{name: string, publicKey: string, keypair: web3.Keypair}>} wallets - Wallets to validate
 * @param {Object} options - Validation options
 * @param {number} [options.solSpendPerWallet=0] - SOL amount each wallet will spend
 * @param {boolean} [options.mayCreateTokenAccounts=true] - Whether operations might create token accounts
 * @param {boolean} [options.isTipper=false] - Whether wallet will pay additional Jito tips
 * @returns {Promise<Object>} Validation results with detailed breakdown
 */
async function validateWalletsForTokenOperations(wallets, options = {}) {
    const {
        solSpendPerWallet = 0,
        mayCreateTokenAccounts = true,
        isTipper = false
    } = options;
    
    const connection = getSolanaConnection();
    const results = {
        overallValid: true,
        validWallets: [],
        invalidWallets: [],
        summary: {
            totalWallets: wallets.length,
            validCount: 0,
            invalidCount: 0
        }
    };
    
    console.log(`[WalletService] Validating ${wallets.length} wallets for token operations...`);
    console.log(`[WalletService] Parameters: SOL spend ${solSpendPerWallet}, may create token accounts: ${mayCreateTokenAccounts}, is tipper: ${isTipper}`);
    
    for (const wallet of wallets) {
        try {
            // Get current balance
            const balance = await getWalletBalance(connection, wallet.keypair.publicKey);
            
            // Calculate cost requirements based on operation type
            const accountTypesToCreate = mayCreateTokenAccounts ? ['token'] : [];
            const priorityFee = isTipper ? 100000 : 20000; // Higher fee for tippers
            
            const costCalculation = calculateTransactionCostWithRent({
                priorityFeeMicrolamports: priorityFee,
                computeUnitLimit: 300000,
                accountTypesToCreate: accountTypesToCreate,
                includeRentBuffer: true
            });
            
            // Validate balance including spend amount
            const validation = validateBalanceForRentOperations(
                balance, 
                costCalculation, 
                solSpendPerWallet
            );
            
            const walletResult = {
                name: wallet.name,
                publicKey: wallet.publicKey,
                balance: balance,
                validation: validation,
                requirements: {
                    transactionFee: costCalculation.summary.transactionFeeSOL,
                    rentRequirements: costCalculation.summary.totalRentRequiredSOL,
                    rentBuffer: costCalculation.summary.rentBufferSOL,
                    solSpend: solSpendPerWallet,
                    totalRequired: validation.totalRequired
                }
            };
            
            if (validation.isValid) {
                results.validWallets.push(walletResult);
                results.summary.validCount++;
                console.log(`[WalletService] ✅ ${wallet.name}: ${balance} SOL (required: ${validation.totalRequired.toFixed(8)} SOL)`);
            } else {
                results.invalidWallets.push(walletResult);
                results.summary.invalidCount++;
                results.overallValid = false;
                console.warn(`[WalletService] ❌ ${wallet.name}: ${balance} SOL (required: ${validation.totalRequired.toFixed(8)} SOL, shortfall: ${validation.shortfall.toFixed(8)} SOL)`);
            }
            
        } catch (error) {
            console.error(`[WalletService] Error validating wallet ${wallet.name}: ${error.message}`);
            results.invalidWallets.push({
                name: wallet.name,
                publicKey: wallet.publicKey,
                error: error.message,
                validation: { isValid: false }
            });
            results.summary.invalidCount++;
            results.overallValid = false;
        }
    }
    
    console.log(`[WalletService] Validation complete: ${results.summary.validCount}/${results.summary.totalWallets} wallets have sufficient balance`);
    
    if (!results.overallValid) {
        const totalShortfall = results.invalidWallets
            .filter(w => w.validation && w.validation.shortfall)
            .reduce((sum, w) => sum + w.validation.shortfall, 0);
            
        if (totalShortfall > 0) {
            console.warn(`[WalletService] Total shortfall across all invalid wallets: ${totalShortfall.toFixed(8)} SOL`);
        }
    }
    
    return results;
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
    getFormattedTokenBalanceService,
    
    // MONOCODE Compliance: Enhanced validation services for rent-aware operations
    validateWalletsForTokenOperations
}; 
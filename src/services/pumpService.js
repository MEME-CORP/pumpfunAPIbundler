/**
 * PUMP SERVICE - Token Creation and Trading Operations
 * 
 * ✅ MIGRATED: This service now uses local transactions via Pump Portal API
 * instead of Jito bundles (review july 28th commit for using jito again) to avoid rate limiting issues. 
 * Transactions are executed in parallel batches of 4 with 0.0005 SOL priority fee for optimal performance.
 * 
 * MONOCODE Compliance: Observable implementation with structured logging,
 * explicit error handling, and dependency transparency.
 */

const web3 = require('@solana/web3.js');
const bs58 = require('bs58');
const fs = require('fs').promises; // Still needed for LATEST_MINT_FILE operations
const path = require('path'); // Still needed for LATEST_MINT_FILE path
const { Keypair, SystemProgram, LAMPORTS_PER_SOL } = web3;
const { 
    saveKeypairToFile, 
    loadKeypairFromFile, 
    loadChildWalletsFromFile, 
    getWalletBalance, 
    getSolanaConnection,
    WALLETS_DIR,
    MOTHER_WALLET_FILE, // Though likely not used directly here
    CHILD_WALLETS_FILE,
} = require('../utils/walletUtils');
// MONOCODE Fix: Use rate-limited token balance function instead of direct RPC calls
const { getTokenBalance } = require('../utils/solanaUtils');
const { validateWalletsForTokenOperations } = require('./walletService');
const { 
    uploadMetadataToPumpPortal, 
    getTransactionsFromPumpPortal, 
    preparePumpTransactionsForJito,
    DEFAULT_JITO_TIP_VIA_PUMP_PORTAL_PRIORITY_FEE,
    DEFAULT_PUMP_PORTAL_NOMINAL_SUBSEQUENT_TX_FEE_SOL
} = require('../utils/pumpAndJitoUtils');
const { 
    createTokenLocalTransaction, 
    executeTradeLocalTransaction,
    executeParallelTransactions, 
    confirmParallelTransactions,
    confirmTransactionViaWebSocket,
    DEFAULT_PRIORITY_FEE 
} = require('./localTransactionService');
const { sleep, getRecentBlockhash, confirmTransactionAdvanced } = require('../utils/transactionUtils');

// MONOCODE Compliance: Fix bs58 decoder compatibility issue
const bs58Decoder = bs58.default || bs58;

const DEV_WALLET_NAME = "DevWallet";
const FIRST_BUNDLED_BASE_NAME = "First Bundled Wallet";
const MAX_BUYERS_IN_CREATE_BUNDLE = 4; // DevWallet + 4 First Bundled Wallets = 5 TXs max for create bundle
const MAX_WALLETS_PER_BUNDLE = 5; // Max transactions per Jito bundle for batch operations

const MIN_SOL_BALANCE_TIPPER = 0.055;
const MIN_SOL_BALANCE_NON_TIPPER = 0.025;

// Placeholder for where to save the mint address, similar to latestMint_05script_2tx.txt
const LATEST_MINT_FILE = path.join(process.cwd(), 'data', 'latestMint_API.txt'); 

/**
 * Validates SOL balances for wallets involved in token operations with rent consideration
 * MONOCODE Compliance: Enhanced validation including rent exemption requirements for token accounts
 * @param {object[]} wallets - Array of wallet objects { name, publicKey, keypair, isTipper }
 * @param {Object} [operationOptions={}] - Options for the operation being validated
 * @param {number} [operationOptions.solSpendPerWallet=0] - SOL amount each wallet will spend
 * @returns {Promise<boolean>} True if all balances are sufficient for token operations, false otherwise.
 */
async function checkWalletBalancesForTokenOperations(wallets, operationOptions = {}) {
    const { solSpendPerWallet = 0 } = operationOptions;
    
    console.log(`[PumpService] Validating ${wallets.length} wallets for token operations (may create ATAs)`);
    
    // Group wallets by tipper status for more accurate validation
    const tippers = wallets.filter(w => w.isTipper);
    const nonTippers = wallets.filter(w => !w.isTipper);
    
    let allValid = true;
    
    // Validate tippers (higher requirements due to Jito tips)
    if (tippers.length > 0) {
        console.log(`[PumpService] Validating ${tippers.length} tipper wallet(s)...`);
        const tipperValidation = await validateWalletsForTokenOperations(tippers, {
            solSpendPerWallet: solSpendPerWallet,
            mayCreateTokenAccounts: true,
            isTipper: true
        });
        
        if (!tipperValidation.overallValid) {
            console.error(`[PumpService] ❌ ${tipperValidation.summary.invalidCount} tipper wallet(s) have insufficient balance`);
            for (const invalid of tipperValidation.invalidWallets) {
                if (invalid.validation && invalid.validation.shortfall) {
                    console.error(`[PumpService]   ${invalid.name}: needs ${invalid.validation.shortfall.toFixed(8)} more SOL (has ${invalid.balance}, needs ${invalid.validation.totalRequired.toFixed(8)})`);
                }
            }
            allValid = false;
        }
    }
    
    // Validate non-tippers
    if (nonTippers.length > 0) {
        console.log(`[PumpService] Validating ${nonTippers.length} non-tipper wallet(s)...`);
        const nonTipperValidation = await validateWalletsForTokenOperations(nonTippers, {
            solSpendPerWallet: solSpendPerWallet,
            mayCreateTokenAccounts: true,
            isTipper: false
        });
        
        if (!nonTipperValidation.overallValid) {
            console.error(`[PumpService] ❌ ${nonTipperValidation.summary.invalidCount} non-tipper wallet(s) have insufficient balance`);
            for (const invalid of nonTipperValidation.invalidWallets) {
                if (invalid.validation && invalid.validation.shortfall) {
                    console.error(`[PumpService]   ${invalid.name}: needs ${invalid.validation.shortfall.toFixed(8)} more SOL (has ${invalid.balance}, needs ${invalid.validation.totalRequired.toFixed(8)})`);
                }
            }
            allValid = false;
        }
    }
    
    if (allValid) {
        console.log(`[PumpService] ✅ All wallets have sufficient balance for token operations (including rent exemption)`);
    } else {
        console.error(`[PumpService] ❌ Some wallets have insufficient balance. Token operations may fail with 'Insufficient Funds For Rent' errors.`);
    }
    
    return allValid;
}

/**
 * Service to create a token and perform initial buys.
 * Based on 05-createTokenAndBuy.js
 * DevWallet creates token via local transaction. DevWallet + "First Bundled Wallet 1-4" (up to 4) 
 * then execute parallel buy transactions with confirmation.
 * 
 * MONOCODE Compliance: Updated to handle image buffers and API-provided wallets
 */
async function createAndBuyService(
    tokenMetadata, // { name, symbol, description, twitter, telegram, website, showName, createAmountSOL }
    imageData, // { buffer: Buffer, fileName: string, mimetype: string, size: number } or null
    wallets, // Array of { name: string, privateKey: string } - API-provided wallets
    buyAmountsSOL, // { devWalletBuySOL: 0.01, firstBundledWallet1BuySOL: 0.01, ... } up to 4 first bundled
    slippageBps = 2500 // Default 25% slippage (2500 basis points)
) {
    const connection = getSolanaConnection();
    const results = {
        success: false,
        mintAddress: null,
        bundleId: null,
        transactions: [],
        message: '',
        metadataUri: null,
    };

    try {
        // 1. Load Wallets from API request (MONOCODE: Dependency Transparency)
        console.log("[PumpService] Loading keypairs from API request...");
        if (!wallets || wallets.length === 0) {
            throw new Error("No wallets provided in the request.");
        }

        const loadedWallets = [];
        for (const wallet of wallets) {
            try {
                const keypair = Keypair.fromSecretKey(bs58Decoder.decode(wallet.privateKey));
                loadedWallets.push({
                    name: wallet.name,
                    keypair,
                    publicKey: keypair.publicKey.toBase58()
                });
            } catch (error) {
                console.error(`Failed to decode private key for wallet "${wallet.name}":`, error);
                throw new Error(`Invalid private key for wallet "${wallet.name}".`);
            }
        }

        console.log(`[PumpService] Successfully loaded ${loadedWallets.length} wallets from API request`);

        const devWallet = loadedWallets.find(w => w.name === DEV_WALLET_NAME);
        if (!devWallet) {
            throw new Error(`Creator wallet named "${DEV_WALLET_NAME}" must be provided in the wallets array.`);
        }

        // Identify participating wallets based on buy amounts
        const participatingWallets = [];
        
        // Add DevWallet as tipper (for create transaction)
        participatingWallets.push({ ...devWallet, isTipper: true });

        // Add buyers based on buyAmountsSOL
        if (buyAmountsSOL.devWalletBuySOL > 0) {
            // DevWallet is both creator and buyer - already added as tipper
        }

        // MONOCODE Fix: Process ALL wallets with buy amounts (not just hardcoded names)
        console.log(`[PumpService] Processing buy amounts for all provided wallets...`);
        
        // Process all buy amount keys to find participating wallets
        for (const [buyKey, buyAmount] of Object.entries(buyAmountsSOL)) {
            if (buyKey !== 'devWalletBuySOL' && buyAmount > 0) {
                console.log(`[PumpService] Found buy amount: ${buyKey} = ${buyAmount} SOL`);
                
                // Find corresponding wallet by matching buy key pattern to wallet name
                let matchingWallet = null;
                
                // Try different naming patterns
                const patterns = [
                    buyKey.replace('BuySOL', '').replace(/([A-Z])/g, ' $1').trim().replace(/^\w/, c => c.toUpperCase()), // camelCase to Title Case
                    buyKey.replace('BuySOL', ''), // Direct match without transformation
                ];
                
                for (const pattern of patterns) {
                    matchingWallet = loadedWallets.find(w => 
                        w.name.toLowerCase().replace(/\s+/g, '') === pattern.toLowerCase().replace(/\s+/g, '')
                    );
                    if (matchingWallet) {
                        console.log(`[PumpService] Matched wallet "${matchingWallet.name}" to buy key "${buyKey}"`);
                        break;
                    }
                }
                
                if (matchingWallet) {
                    participatingWallets.push({ ...matchingWallet, isTipper: false });
                } else {
                    console.warn(`[PumpService] Warning: No wallet found matching buy key "${buyKey}". Available wallets: ${loadedWallets.map(w => w.name).join(', ')}`);
                }
            }
        }

        // Deduplicate for balance check (important if DevWallet is both creator and buyer)
        const uniqueWalletsForBalanceCheck = participatingWallets.reduce((acc, current) => {
            const existing = acc.find(item => item.publicKey === current.publicKey);
            if (!existing) {
                return acc.concat([current]);
            } else {
                // If already present, make sure 'isTipper' is true if one of them is a tipper
                if (current.isTipper) existing.isTipper = true;
                return acc;
            }
        }, []);

        // Calculate SOL spend per wallet for validation (sum of buy amounts + create amount for DevWallet)
        const devWalletCreateAmount = tokenMetadata.createAmountSOL || 0.001;
        const devWalletTotalSpend = devWalletCreateAmount + (buyAmountsSOL.devWalletBuySOL || 0);
        const maxBuyAmount = Math.max(
            devWalletTotalSpend, // DevWallet spends on both create and buy
            ...Object.keys(buyAmountsSOL)
                .filter(key => key.startsWith('firstBundledWallet'))
                .map(key => buyAmountsSOL[key] || 0)
        );
        
        if (!await checkWalletBalancesForTokenOperations(uniqueWalletsForBalanceCheck, { 
            solSpendPerWallet: maxBuyAmount 
        })) {
            throw new Error("Insufficient SOL balance in one or more participating wallets for token operations (including rent exemption requirements).");
        }

        // 2. Metadata and IPFS Upload
        // MONOCODE Compliance: Progressive Construction with memory-based image handling
        let imageBuffer, imageFileName;
        if (imageData && imageData.buffer) {
            imageBuffer = imageData.buffer;
            imageFileName = imageData.fileName;
            console.log(`[PumpService] Using uploaded image: ${imageFileName} (${imageData.size} bytes, ${imageData.mimetype})`);
        } else {
            console.log(`[PumpService] No image provided. Creating token with metadata only.`);
        }
        
        // Filter tokenMetadata to only include fields needed for IPFS metadata (exclude createAmountSOL)
        const metadataForUpload = {
            name: tokenMetadata.name,
            symbol: tokenMetadata.symbol,
            description: tokenMetadata.description,
            twitter: tokenMetadata.twitter,
            telegram: tokenMetadata.telegram,
            website: tokenMetadata.website,
            showName: tokenMetadata.showName
        };
        
        results.metadataUri = await uploadMetadataToPumpPortal(metadataForUpload, imageBuffer, imageFileName);
        console.log(`Token metadata uploaded to IPFS: ${results.metadataUri}`);

        // 3. Generate Mint Keypair
        const mintKeypair = Keypair.generate();
        results.mintAddress = mintKeypair.publicKey.toBase58();
        console.log(`New token mint address: ${results.mintAddress}`);

        // 4. Construct bundledTxArgs for Pump Portal
        // MONOCODE Fix: Ensure correct format for pump.fun API
        // - slippage: Convert basis points to percentage (2500 -> 25)
        // - priorityFee: Keep as SOL (0.001, not 1000000 lamports)
        // - amount: Keep as SOL when denominatedInSol=true (0.005, not "5000000" lamports)
        const bundledTxArgs = [];
        const walletSignerMap = []; // To map raw tx to keypair for signing

        // Tx 1: Create token (DevWallet)
        bundledTxArgs.push({
            publicKey: devWallet.publicKey,
            action: "create",
            tokenMetadata: {
                name: tokenMetadata.name,
                symbol: tokenMetadata.symbol,
                uri: results.metadataUri,
            },
            mint: results.mintAddress,
            denominatedInSol: "true", // Match working test format - create with SOL amount
            amount: tokenMetadata.createAmountSOL || 0.001, // SOL amount for token creation (default 0.001 SOL)
            slippage: Math.floor(slippageBps / 100), // Convert basis points to percentage (2500 -> 25)
            priorityFee: DEFAULT_JITO_TIP_VIA_PUMP_PORTAL_PRIORITY_FEE, // Keep as SOL, don't convert to lamports
            pool: "pump",
        });
        walletSignerMap.push({ wallet: devWallet, isCreate: true });

        // Tx 2+: Buys (Dynamic processing - all wallets with buy amounts)
        const buyers = [];
        
        // Process all buy amount keys dynamically
        Object.keys(buyAmountsSOL).forEach(buyKey => {
            if (buyAmountsSOL[buyKey] > 0) {
                // Find matching wallet using the same logic as the validation phase
                const matchingWallet = loadedWallets.find(wallet => {
                    const normalizedWalletName = wallet.name.toLowerCase().replace(/\s+/g, '');
                    const normalizedBuyKey = buyKey.replace('BuySOL', '').toLowerCase();
                    return normalizedWalletName === normalizedBuyKey;
                });
                
                if (matchingWallet) {
                    buyers.push({ wallet: matchingWallet, buySOL: buyAmountsSOL[buyKey] });
                    console.log(`[PumpService] Added buyer: ${matchingWallet.name} with ${buyAmountsSOL[buyKey]} SOL`);
                } else {
                    console.warn(`[PumpService] No wallet found for buy key: ${buyKey}`);
                }
            }
        });
        
        // MONOCODE Fix: Remove Jito bundle limit - now using local parallel transactions
        console.log(`[PumpService] Processing ${buyers.length} buy transactions + 1 create transaction via local parallel execution`);
        
        // Local transactions support batching - no hard limit needed // but there is a pseudo hard limit for buyers length now at 200 wallets
        if (buyers.length > 200) {
            console.warn(`[PumpService] Warning: ${buyers.length} buy transactions requested. Consider using batch-buy endpoint for better performance.`);
        }

        buyers.forEach(buyerInfo => {
            bundledTxArgs.push({
                publicKey: buyerInfo.wallet.publicKey,
                action: "buy",
                mint: results.mintAddress,
                denominatedInSol: "true", // Buying with SOL
                amount: buyerInfo.buySOL, // Keep as SOL, don't convert to lamports
                slippage: Math.floor(slippageBps / 100), // Convert basis points to percentage (2500 -> 25)
                priorityFee: DEFAULT_PUMP_PORTAL_NOMINAL_SUBSEQUENT_TX_FEE_SOL, // Keep as SOL, don't convert to lamports
                pool: "pump",
            });
            walletSignerMap.push({ wallet: buyerInfo.wallet, isCreate: false });
        });
        
        // 5. Create Token using Local Transaction (Step 1)
        console.log(`[PumpService] Creating token ${tokenMetadata.symbol} using local transaction...`);
        const createSignature = await createTokenLocalTransaction(
            {
                name: tokenMetadata.name,
                symbol: tokenMetadata.symbol, 
                description: tokenMetadata.description,
                twitter: tokenMetadata.twitter,
                telegram: tokenMetadata.telegram,
                website: tokenMetadata.website
            },
            results.metadataUri, // Use the metadata URI from uploadMetadataToPumpPortal
            mintKeypair,
            devWallet.keypair,
            tokenMetadata.createAmountSOL || 0.001,
            Math.floor(slippageBps / 100)
        );
        
        results.transactions.push({
            walletName: devWallet.name,
            action: 'create',
            signature: createSignature,
            amount: tokenMetadata.createAmountSOL || 0.001
        });
        
        console.log(`[PumpService] ✅ Token creation transaction sent: ${createSignature}`);
        
        // 6. Confirm Token Creation (Step 2)
        console.log(`[PumpService] Confirming token creation transaction via WebSocket...`);
        const createConfirmed = await confirmTransactionViaWebSocket(createSignature, 'confirmed', 30000);
        if (!createConfirmed) {
            throw new Error(`Token creation transaction confirmation failed: ${createSignature}`);
        }
        console.log(`[PumpService] ✅ Token creation confirmed via WebSocket!`);
        
        // 7. Execute Parallel Buy Transactions (Step 3)
        if (buyers.length > 0) {
            console.log(`[PumpService] Executing ${buyers.length} parallel buy transactions...`);
            
            const buyRequests = buyers.map(buyerInfo => ({
                action: 'buy',
                mintAddress: results.mintAddress,
                signerKeypair: buyerInfo.wallet.keypair,
                amount: buyerInfo.buySOL,
                denominatedInSol: true,
                slippage: slippageBps,
                walletName: buyerInfo.wallet.name
            }));
            
            // Execute buy transactions in parallel (max 4 at a time)
            const buyResults = await executeParallelTransactions(buyRequests, 4);
            
            // Add buy results to transactions array
            buyResults.forEach(buyResult => {
                results.transactions.push({
                    walletName: buyResult.walletName,
                    action: buyResult.action,
                    signature: buyResult.signature || null,
                    success: buyResult.success,
                    error: buyResult.error || null,
                    amount: buyResult.amount
                });
            });
            
            const successfulBuys = buyResults.filter(r => r.success).length;
            console.log(`[PumpService] ✅ Buy transactions complete: ${successfulBuys}/${buyResults.length} successful`);
            
            // Confirm buy transactions in parallel
            const buySignatures = buyResults.filter(r => r.success).map(r => r.signature);
            if (buySignatures.length > 0) {
                console.log(`[PumpService] Confirming ${buySignatures.length} buy transactions...`);
                const confirmResults = await confirmParallelTransactions(buySignatures);
                const confirmedBuys = confirmResults.filter(r => r.confirmed).length;
                console.log(`[PumpService] ✅ Buy confirmations complete: ${confirmedBuys}/${buySignatures.length} confirmed`);
            }
        }
        
        results.success = true;
        results.message = `Token ${tokenMetadata.symbol} created and ${buyers.length} buy transactions completed successfully. Mint: ${results.mintAddress}`;
        console.log(`[PumpService] ✅ Create and buy service completed successfully!`);

        // Save mint address
        await fs.mkdir(path.dirname(LATEST_MINT_FILE), { recursive: true });
        await fs.writeFile(LATEST_MINT_FILE, results.mintAddress);
        console.log(`Saved new mint address to ${LATEST_MINT_FILE}`);
        

    } catch (error) {
        console.error("Error in createAndBuyService:", error);
        results.message = error.message;
        results.success = false;
        // results.bundleId may or may not be set
    }
    return results;
}

/**
 * Service for batch buying a token with multiple child wallets.
 * Excludes DevWallet and First Bundled Wallets 1-4.
 * Buys in batches of up to MAX_WALLETS_PER_BUNDLE.
 */
async function batchBuyService(
    mintAddress, 
    solAmountPerWallet, 
    slippageBps = 2500, 
    targetWalletNames, // Optional: array of specific child wallet names to use (must be eligible)
    wallets // Required: Array of { name: string, privateKey: string } - API-provided wallets
) {
    const connection = getSolanaConnection();
    const overallResult = {
        success: false,
        message: '',
        mintAddress: mintAddress,
        totalBundlesSent: 0,
        successfulBundles: 0,
        failedBundles: 0,
        skippedBundles: 0,
        bundleResults: [] // Array of { bundleId, success, message, transactions: [] }
    };

    try {
        // MONOCODE Fix: Use provided wallets from API request instead of loading from file
        if (!wallets || wallets.length === 0) {
            throw new Error("No wallets provided in the request.");
        }

        const loadedWallets = [];
        for (const wallet of wallets) {
            try {
                const keypair = Keypair.fromSecretKey(bs58Decoder.decode(wallet.privateKey));
                loadedWallets.push({
                    name: wallet.name,
                    keypair,
                    publicKey: keypair.publicKey.toBase58()
                });
            } catch (error) {
                console.error(`Failed to decode private key for wallet "${wallet.name}":`, error);
                throw new Error(`Invalid private key for wallet "${wallet.name}".`);
            }
        }

        console.log(`[PumpService] Successfully loaded ${loadedWallets.length} wallets from API request`);

        // Filter for eligible wallets
        let eligibleWallets = loadedWallets.filter(wallet => {
            if (wallet.name === DEV_WALLET_NAME) return false;
            for (let i = 1; i <= MAX_BUYERS_IN_CREATE_BUNDLE; i++) { // Max 4 "First Bundled Wallets"
                if (wallet.name === `${FIRST_BUNDLED_BASE_NAME} ${i}`) return false;
            }
            return true;
        });

        if (targetWalletNames && targetWalletNames.length > 0) {
            eligibleWallets = eligibleWallets.filter(ew => targetWalletNames.includes(ew.name));
        }

        if (eligibleWallets.length === 0) {
            throw new Error("No eligible child wallets found for batch buy operation based on criteria.");
        }

        console.log(`Attempting batch buy for ${mintAddress} with ${eligibleWallets.length} eligible wallets.`);

        const numBatches = Math.ceil(eligibleWallets.length / MAX_WALLETS_PER_BUNDLE);

        for (let i = 0; i < numBatches; i++) {
            const batch = eligibleWallets.slice(i * MAX_WALLETS_PER_BUNDLE, (i + 1) * MAX_WALLETS_PER_BUNDLE);
            if (batch.length === 0) continue;

            console.log(`Processing batch ${i + 1}/${numBatches} with ${batch.length} wallets.`);
            const batchBundleResult = {
                bundleId: null,
                success: false,
                message: '',
                skipped: false,
                transactions: []
            };

            try {
                const walletsForBalanceCheck = batch.map((wallet, index) => ({
                    ...wallet,
                    isTipper: index === 0 // First wallet in batch is the tipper
                }));
                if (!await checkWalletBalancesForTokenOperations(walletsForBalanceCheck, { 
                    solSpendPerWallet: solAmountPerWallet 
                })) {
                    throw new Error(`Insufficient SOL balance in one or more wallets for batch ${i + 1} (including rent exemption requirements).`);
                }

                // Prepare buy requests for parallel execution
                const buyRequests = batch.map(wallet => ({
                    action: 'buy',
                    mintAddress: mintAddress,
                    signerKeypair: wallet.keypair,
                    amount: solAmountPerWallet,
                    denominatedInSol: true,
                    slippage: slippageBps,
                    walletName: wallet.name
                }));

                console.log(`[PumpService] Executing ${batch.length} parallel buy transactions for batch ${i + 1} of ${numBatches}...`);

                // Execute buy transactions in parallel (max 4 at a time)
                const buyResults = await executeParallelTransactions(buyRequests, 4);
                
                // Add results to batch result
                buyResults.forEach(buyResult => {
                    batchBundleResult.transactions.push({
                        walletName: buyResult.walletName,
                        action: buyResult.action,
                        signature: buyResult.signature || null,
                        success: buyResult.success,
                        error: buyResult.error || null,
                        amount: buyResult.amount
                    });
                });
                
                const successfulBuys = buyResults.filter(r => r.success).length;
                console.log(`[PumpService] ✅ Batch ${i + 1} buy transactions complete: ${successfulBuys}/${buyResults.length} successful`);
                
                // Confirm buy transactions in parallel
                const buySignatures = buyResults.filter(r => r.success).map(r => r.signature);
                if (buySignatures.length > 0) {
                    console.log(`[PumpService] Confirming ${buySignatures.length} buy transactions for batch ${i + 1}...`);
                    const confirmResults = await confirmParallelTransactions(buySignatures);
                    const confirmedBuys = confirmResults.filter(r => r.confirmed).length;
                    console.log(`[PumpService] ✅ Batch ${i + 1} confirmations complete: ${confirmedBuys}/${buySignatures.length} confirmed`);
                }
                
                batchBundleResult.success = successfulBuys > 0;
                batchBundleResult.message = `Batch ${i + 1}: ${successfulBuys}/${batch.length} buy transactions successful`;
                console.log(`[PumpService] ✅ Batch ${i + 1} processing complete!`);
                
                if (batchBundleResult.success) {
                    overallResult.successfulBundles++;
                } else {
                    overallResult.failedBundles++;
                }
            } catch (batchError) {
                console.error(`Error processing batch ${i + 1}:`, batchError);
                batchBundleResult.message = batchError.message;
                batchBundleResult.success = false;
                overallResult.failedBundles++;
            }
            overallResult.bundleResults.push(batchBundleResult);
            overallResult.totalBundlesSent++;
            if (i < numBatches - 1) await sleep(2000); // Delay between sending bundles
        }

        overallResult.success = overallResult.failedBundles === 0 && overallResult.totalBundlesSent > 0;
        if (overallResult.success) {
            overallResult.message = `All ${overallResult.successfulBundles} batch buy bundles confirmed successfully.`;
        } else if (overallResult.totalBundlesSent > 0) {
            overallResult.message = `Batch buy process completed with ${overallResult.successfulBundles} successful and ${overallResult.failedBundles} failed bundles out of ${overallResult.totalBundlesSent}.`;
        } else {
            overallResult.message = "No batches were processed.";
        }

    } catch (error) {
        console.error("Error in batchBuyService:", error);
        overallResult.message = error.message;
        overallResult.success = false;
    }
    return overallResult;
}

/**
 * Service for DevWallet to sell a percentage of tokens.
 */
async function devSellService(
    mintAddress,
    sellAmountPercentage, // e.g., "50%" or "100%"
    slippageBps = 2500,
    wallets // Required: Array of { name: string, privateKey: string } - API-provided wallets
) {
    const connection = getSolanaConnection();
    const results = {
        success: false,
        message: '',
        mintAddress: mintAddress,
        bundleId: null,
        transactions: []
    };

    try {
        // MONOCODE Fix: Use provided wallets from API request instead of loading from file
        if (!wallets || wallets.length === 0) {
            throw new Error("No wallets provided in the request.");
        }

        const loadedWallets = [];
        for (const wallet of wallets) {
            try {
                const keypair = Keypair.fromSecretKey(bs58Decoder.decode(wallet.privateKey));
                loadedWallets.push({
                    name: wallet.name,
                    keypair,
                    publicKey: keypair.publicKey.toBase58()
                });
            } catch (error) {
                console.error(`Failed to decode private key for wallet "${wallet.name}":`, error);
                throw new Error(`Invalid private key for wallet "${wallet.name}".`);
            }
        }

        console.log(`[PumpService] Successfully loaded ${loadedWallets.length} wallets from API request`);

        const devWallet = loadedWallets.find(w => w.name === DEV_WALLET_NAME);
        if (!devWallet) {
            throw new Error("DevWallet not found in provided wallets array.");
        }

        console.log(`Attempting to sell ${sellAmountPercentage} of ${mintAddress} from DevWallet (${devWallet.publicKey}).`);

        // MONOCODE Fix: Validate SPL token balance before attempting sell using rate-limited RPC
        console.log(`[PumpService] Checking SPL token balance for ${devWallet.publicKey} and mint ${mintAddress}...`);
        const tokenBalanceInfo = await getTokenBalance(devWallet.publicKey, mintAddress, connection);
        const tokenBalance = tokenBalanceInfo.balance;
        
        if (tokenBalance === 0) {
            throw new Error(`DevWallet has no tokens of mint ${mintAddress} to sell. Current balance: ${tokenBalance}`);
        }

        // Parse percentage and calculate actual sell amount
        const percentage = parseFloat(sellAmountPercentage.replace('%', ''));
        if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
            throw new Error(`Invalid sell percentage: ${sellAmountPercentage}. Must be between 0 and 100.`);
        }

        const amountToSell = Math.floor(tokenBalance * (percentage / 100));
        console.log(`[PumpService] Token balance: ${tokenBalance}, selling ${percentage}% (${amountToSell} tokens)`);

        if (amountToSell === 0) {
            throw new Error(`Calculated sell amount is zero. Token balance (${tokenBalance}) may be too low for ${percentage}% sell.`);
        }

        // DevWallet is the tipper for this single transaction bundle
        if (!await checkWalletBalancesForTokenOperations([{ ...devWallet, isTipper: true }], { 
            solSpendPerWallet: 0 // Selling tokens doesn't require SOL spend, but may need rent for ATAs
        })) {
            throw new Error("Insufficient SOL balance in DevWallet to cover transaction and Jito tip (including rent exemption requirements).");
        }

        console.log(`[PumpService] Executing DevWallet sell transaction for ${sellAmountPercentage} of ${mintAddress}...`);

        // Execute single sell transaction using local transaction service
        const sellSignature = await executeTradeLocalTransaction(
            'sell',
            mintAddress,
            devWallet.keypair,
            amountToSell, // Use calculated token amount instead of percentage
            false, // denominatedInSol
            slippageBps
        );

        results.transactions.push({
            walletName: devWallet.name,
            action: "sell",
            signature: sellSignature,
            success: true,
            error: null,
            amount: amountToSell // Log actual token amount sold
        });

        console.log(`[PumpService] ✅ DevWallet sell transaction successful: ${sellSignature}`);
        
        // Confirm the sell transaction via WebSocket
        console.log(`[PumpService] Confirming DevWallet sell transaction via WebSocket...`);
        const confirmed = await confirmTransactionViaWebSocket(sellSignature, 'confirmed', 30000);
        
        if (confirmed) {
            results.success = true;
            results.message = `DevWallet successfully sold ${sellAmountPercentage} of ${mintAddress}. Transaction: ${sellSignature}`;
            console.log(`[PumpService] ✅ DevWallet sell transaction confirmed!`);
        } else {
            throw new Error(`DevWallet sell transaction ${sellSignature} confirmation failed`);
        }

    } catch (error) {
        console.error("Error in devSellService:", error);
        results.message = error.message;
        results.success = false;
    }
    return results;
}

/**
 * Service for batch selling tokens from all child wallets (excluding DevWallet).
 * Executes parallel sell transactions in batches of up to 4 wallets at a time.
 */
async function batchSellService(
    mintAddress,
    sellAmountPercentage, // e.g., "50%" or "100%"
    slippageBps = 2500,
    targetWalletNames, // Optional: array of specific child wallet names to use (must be eligible)
    wallets // Required: Array of { name: string, privateKey: string } - API-provided wallets
) {
    const connection = getSolanaConnection();
    const overallResult = {
        success: false,
        message: '',
        mintAddress: mintAddress,
        totalBundlesSent: 0,
        successfulBundles: 0,
        failedBundles: 0,
        bundleResults: [] // Array of { bundleId, success, message, transactions: [] }
    };

    try {
        // MONOCODE Fix: Use provided wallets from API request instead of loading from file
        if (!wallets || wallets.length === 0) {
            throw new Error("No wallets provided in the request.");
        }

        const loadedWallets = [];
        for (const wallet of wallets) {
            try {
                const keypair = Keypair.fromSecretKey(bs58Decoder.decode(wallet.privateKey));
                loadedWallets.push({
                    name: wallet.name,
                    keypair,
                    publicKey: keypair.publicKey.toBase58()
                });
            } catch (error) {
                console.error(`Failed to decode private key for wallet "${wallet.name}":`, error);
                throw new Error(`Invalid private key for wallet "${wallet.name}".`);
            }
        }

        console.log(`[PumpService] Successfully loaded ${loadedWallets.length} wallets from API request`);

        // Filter for eligible wallets (exclude DevWallet by default)
        let eligibleWallets = loadedWallets.filter(wallet => wallet.name !== DEV_WALLET_NAME);

        if (targetWalletNames && targetWalletNames.length > 0) {
            eligibleWallets = eligibleWallets.filter(ew => targetWalletNames.includes(ew.name));
        }

        if (eligibleWallets.length === 0) {
            throw new Error("No eligible child wallets found for batch sell operation based on criteria.");
        }

        console.log(`Attempting batch sell for ${mintAddress} with ${eligibleWallets.length} eligible wallets.`);

        // Format sellAmountPercentage to ensure it has a % symbol if it's a string
        if (typeof sellAmountPercentage === 'string' && !sellAmountPercentage.endsWith('%')) {
            sellAmountPercentage = `${sellAmountPercentage}%`;
        } else if (typeof sellAmountPercentage === 'number') {
            sellAmountPercentage = `${sellAmountPercentage}%`;
        }

        const numBatches = Math.ceil(eligibleWallets.length / MAX_WALLETS_PER_BUNDLE);

        for (let i = 0; i < numBatches; i++) {
            const batch = eligibleWallets.slice(i * MAX_WALLETS_PER_BUNDLE, (i + 1) * MAX_WALLETS_PER_BUNDLE);
            if (batch.length === 0) continue;

            console.log(`Processing batch ${i + 1}/${numBatches} with ${batch.length} wallets.`);
            const batchBundleResult = {
                bundleId: null,
                success: false,
                message: '',
                transactions: []
            };

            try {
                const walletsForBalanceCheck = batch.map((wallet, index) => ({
                    ...wallet,
                    isTipper: index === 0 // First wallet in batch is the tipper
                }));
                if (!await checkWalletBalancesForTokenOperations(walletsForBalanceCheck, { 
                    solSpendPerWallet: 0 // Selling tokens doesn't require SOL spend, but may need rent for ATAs
                })) {
                    throw new Error(`Insufficient SOL balance in one or more wallets for batch ${i + 1} (including rent exemption requirements).`);
                }

                // Prepare sell requests with per-wallet token balance check to avoid zero-amount sells
                const percentage = parseFloat(String(sellAmountPercentage).replace('%', ''));
                if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
                    throw new Error(`Invalid sell percentage: ${sellAmountPercentage}. Must be between 0 and 100.`);
                }
                // MONOCODE Fix: Sequential balance checks to prevent RPC burst overload
                const tokenBalances = [];
                for (const wallet of batch) {
                    const tokenBalanceInfo = await getTokenBalance(wallet.publicKey, mintAddress, connection);
                    tokenBalances.push(tokenBalanceInfo.balance);
                }
                let skippedZero = 0;
                const sellRequests = [];
                batch.forEach((wallet, idx) => {
                    const balance = tokenBalances[idx] || 0;
                    const amountToSell = Math.floor(balance * (percentage / 100));
                    if (amountToSell > 0) {
                        sellRequests.push({
                            action: 'sell',
                            mintAddress: mintAddress,
                            signerKeypair: wallet.keypair,
                            amount: amountToSell,
                            denominatedInSol: false,
                            slippage: slippageBps,
                            walletName: wallet.name
                        });
                    } else {
                        skippedZero++;
                        console.log(`[PumpService] Skipping wallet ${wallet.name} (${wallet.publicKey}) - token balance ${balance} -> ${percentage}% results in 0 tokens to sell`);
                    }
                });

                if (sellRequests.length === 0) {
                    console.warn(`[PumpService] No wallets with non-zero sell amount in batch ${i + 1}. Skipped ${skippedZero} wallet(s).`);
                    batchBundleResult.success = false;
                    batchBundleResult.skipped = true;
                    batchBundleResult.message = `Batch ${i + 1}: skipped (no wallets with non-zero sell amount; skipped ${skippedZero})`;
                    overallResult.skippedBundles++;
                } else {
                    console.log(`[PumpService] Executing ${sellRequests.length} parallel sell transactions for batch ${i + 1} of ${numBatches}...`);

                    // Execute sell transactions in parallel (max 4 at a time)
                    const sellResults = await executeParallelTransactions(sellRequests, 4);
                    
                    // Add results to batch result
                    sellResults.forEach(sellResult => {
                        batchBundleResult.transactions.push({
                            walletName: sellResult.walletName,
                            action: sellResult.action,
                            signature: sellResult.signature || null,
                            success: sellResult.success,
                            error: sellResult.error || null,
                            amount: sellResult.amount
                        });
                    });
                    
                    const successfulSells = sellResults.filter(r => r.success).length;
                    console.log(`[PumpService] ✅ Batch ${i + 1} sell transactions complete: ${successfulSells}/${sellResults.length} successful`);
                    
                    // Confirm sell transactions in parallel
                    const sellSignatures = sellResults.filter(r => r.success).map(r => r.signature);
                    if (sellSignatures.length > 0) {
                        console.log(`[PumpService] Confirming ${sellSignatures.length} sell transactions for batch ${i + 1}...`);
                        const confirmResults = await confirmParallelTransactions(sellSignatures);
                        const confirmedSells = confirmResults.filter(r => r.confirmed).length;
                        console.log(`[PumpService] ✅ Batch ${i + 1} confirmations complete: ${confirmedSells}/${sellSignatures.length} confirmed`);
                    }
                    
                    batchBundleResult.success = successfulSells > 0;
                    batchBundleResult.message = `Batch ${i + 1}: ${successfulSells}/${sellRequests.length} sell transactions successful`;
                    console.log(`[PumpService] ✅ Batch ${i + 1} processing complete!`);
                    
                    if (batchBundleResult.success) {
                        overallResult.successfulBundles++;
                    } else {
                        overallResult.failedBundles++;
                    }
                }
            } catch (batchError) {
                console.error(`Error processing batch ${i + 1}:`, batchError);
                batchBundleResult.message = batchError.message;
                batchBundleResult.success = false;
                overallResult.failedBundles++;
            }
            overallResult.bundleResults.push(batchBundleResult);
            overallResult.totalBundlesSent++;
            if (i < numBatches - 1) await sleep(2000); // Delay between sending bundles
        }

        const executedBundles = overallResult.totalBundlesSent - overallResult.skippedBundles;
        overallResult.success = overallResult.failedBundles === 0; // Treat all-skipped as success (no failures)
        if (overallResult.success) {
            if (executedBundles === 0) {
                overallResult.message = `Batch sell process completed: 0 executed (all ${overallResult.skippedBundles} batches skipped).`;
            } else {
                overallResult.message = `Batch sell process completed successfully: ${overallResult.successfulBundles} successful, 0 failed, ${overallResult.skippedBundles} skipped out of ${overallResult.totalBundlesSent}.`;
            }
        } else {
            overallResult.message = `Batch sell process completed with ${overallResult.successfulBundles} successful, ${overallResult.failedBundles} failed, ${overallResult.skippedBundles} skipped out of ${overallResult.totalBundlesSent}.`;
        }

    } catch (error) {
        console.error("Error in batchSellService:", error);
        overallResult.message = error.message;
        overallResult.success = false;
    }
    return overallResult;
}

module.exports = {
    createAndBuyService,
    batchBuyService,
    devSellService,
    batchSellService,
}; 
const web3 = require('@solana/web3.js');
const bs58 = require('bs58');
const fs = require('fs').promises; // Still needed for LATEST_MINT_FILE operations
const path = require('path'); // Still needed for LATEST_MINT_FILE path
const { Keypair, SystemProgram, LAMPORTS_PER_SOL } = web3;
const { 
    loadKeypairFromFile, 
    loadChildWalletsFromFile, 
    getWalletBalance, 
    getSolanaConnection,
    WALLETS_DIR,
    MOTHER_WALLET_FILE, // Though likely not used directly here
    CHILD_WALLETS_FILE
} = require('../utils/walletUtils');
const { validateWalletsForTokenOperations } = require('./walletService');
const { 
    uploadMetadataToPumpPortal, 
    getTransactionsFromPumpPortal, 
    preparePumpTransactionsForJito,
    DEFAULT_JITO_TIP_VIA_PUMP_PORTAL_PRIORITY_FEE,
    DEFAULT_PUMP_PORTAL_NOMINAL_SUBSEQUENT_TX_FEE_SOL
} = require('../utils/pumpAndJitoUtils');
const { sendJitoBundleWithRetries, pollBundleStatus, waitForBundleViaWebSocket, sleep, getRecentBlockhash } = require('../utils/transactionUtils');

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
 * DevWallet creates. DevWallet + "First Bundled Wallet 1-4" (up to 4) buy in the same Jito bundle.
 * 
 * MONOCODE Compliance: Updated to handle image buffers and API-provided wallets
 */
async function createAndBuyService(
    tokenMetadata, // { name, symbol, description, twitter, telegram, website, showName }
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

        // Add first bundled wallets that are buying
        for (let i = 1; i <= MAX_BUYERS_IN_CREATE_BUNDLE; i++) {
            const buyKey = `firstBundledWallet${i}BuySOL`;
            if (buyAmountsSOL[buyKey] > 0) {
                const walletName = `${FIRST_BUNDLED_BASE_NAME} ${i}`;
                const wallet = loadedWallets.find(w => w.name === walletName);
                if (wallet) {
                    participatingWallets.push({ ...wallet, isTipper: false });
                } else {
                    throw new Error(`Wallet "${walletName}" not found in provided wallets array but is required for buying.`);
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

        // Calculate SOL spend per wallet for validation (sum of buy amounts)
        const maxBuyAmount = Math.max(
            buyAmountsSOL.devWalletBuySOL || 0,
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
        results.metadataUri = await uploadMetadataToPumpPortal(tokenMetadata, imageBuffer, imageFileName);
        console.log(`Token metadata uploaded to IPFS: ${results.metadataUri}`);

        // 3. Generate Mint Keypair
        const mintKeypair = Keypair.generate();
        results.mintAddress = mintKeypair.publicKey.toBase58();
        console.log(`New token mint address: ${results.mintAddress}`);

        // 4. Construct bundledTxArgs for Pump Portal
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
            denominatedInSol: "false", // As per pump.fun example for create
            amount: tokenMetadata.initialSupplyAmount || "1000000000", // Example total supply, make configurable
            slippage: slippageBps.toString(), // Pump portal expects string for slippage (basis points)
            priorityFee: DEFAULT_JITO_TIP_VIA_PUMP_PORTAL_PRIORITY_FEE * LAMPORTS_PER_SOL, // Tip in lamports
            pool: "pump",
        });
        walletSignerMap.push({ wallet: devWallet, isCreate: true });

        // Tx 2+: Buys (DevWallet if applicable, then First Bundled Wallets)
        const buyers = [];
        if (buyAmountsSOL.devWalletBuySOL > 0) {
            buyers.push({ wallet: devWallet, buySOL: buyAmountsSOL.devWalletBuySOL });
        }
        
        for (let i = 1; i <= MAX_BUYERS_IN_CREATE_BUNDLE; i++) {
            const buyKey = `firstBundledWallet${i}BuySOL`;
            if (buyAmountsSOL[buyKey] > 0) {
                const walletName = `${FIRST_BUNDLED_BASE_NAME} ${i}`;
                const wallet = loadedWallets.find(w => w.name === walletName);
                if (wallet) {
                    buyers.push({ wallet: wallet, buySOL: buyAmountsSOL[buyKey] });
                }
            }
        }
        
        if (buyers.length + bundledTxArgs.length > 5) { // +1 for the create transaction
             throw new Error(`Too many transactions for a single Jito bundle. Max 5. Requested: ${buyers.length + 1}`);
        }

        buyers.forEach(buyerInfo => {
            bundledTxArgs.push({
                publicKey: buyerInfo.wallet.publicKey,
                action: "buy",
                mint: results.mintAddress,
                denominatedInSol: "true", // Buying with SOL
                amount: (buyerInfo.buySOL * LAMPORTS_PER_SOL).toString(), // Amount in lamports as string
                slippage: slippageBps.toString(),
                priorityFee: DEFAULT_PUMP_PORTAL_NOMINAL_SUBSEQUENT_TX_FEE_SOL * LAMPORTS_PER_SOL, // Nominal fee for subsequent txs
                pool: "pump",
            });
            walletSignerMap.push({ wallet: buyerInfo.wallet, isCreate: false });
        });
        
        // 5. Get Serialized Transactions from Pump Portal
        const rawTransactionsFromApi = await getTransactionsFromPumpPortal(bundledTxArgs);
        if (rawTransactionsFromApi.length !== bundledTxArgs.length) {
            throw new Error("Mismatch in number of transactions received from Pump Portal.");
        }

        // 6. Prepare and Sign Transactions for Jito
        const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(connection);
        console.log(`[PumpService] Using fresh blockhash: ${blockhash.slice(0, 8)}... Valid until: ${lastValidBlockHeight}`);
        
        const walletKeypairsForSigning = walletSignerMap.map(item => ({
            name: item.wallet.name,
            keypair: item.wallet.keypair, // Assuming keypair is loaded in childWallets
            publicKey: item.wallet.publicKey
        }));

        // MONOCODE Fix: Pass full blockhash data to match working test pattern
        const recentBlockhashData = { blockhash, lastValidBlockHeight };
        
        const { signedEncodedTransactions, primarySignatures } = await preparePumpTransactionsForJito(
            rawTransactionsFromApi,
            walletKeypairsForSigning, // This expects array of {name, keypair, publicKey}
            recentBlockhashData, // Pass full blockhash data
            mintKeypair // Mint keypair signs the create transaction
        );
        
        rawTransactionsFromApi.forEach((tx, i) => {
            results.transactions.push({
                walletName: walletSignerMap[i].wallet.name,
                action: bundledTxArgs[i].action,
                rawTx: tx,
                signedTx: signedEncodedTransactions[i]
            });
        });

        // 7. Send Jito Bundle
        console.log(`Sending ${signedEncodedTransactions.length}-TX Jito bundle...`);
        const bundleId = await sendJitoBundleWithRetries(signedEncodedTransactions);
        results.bundleId = bundleId;
        console.log(`Bundle sent with ID: ${bundleId}`);

        // 8. WebSocket Bundle Confirmation - MONOCODE Fix: Avoid Jito rate limiting
        console.log(`[PumpService] Waiting for bundle confirmation via WebSocket on first signature: ${primarySignatures[0].slice(0, 8)}...`);
        try {
            await waitForBundleViaWebSocket(connection, primarySignatures[0], 'confirmed');
            console.log(`[PumpService] ✅ Bundle confirmed successfully via WebSocket!`);
        } catch (error) {
            throw new Error(`Bundle ${bundleId} WebSocket confirmation failed: ${error.message}`);
        }
        
        results.success = true;
        results.message = `Token ${tokenMetadata.symbol} created and initial buys completed successfully in bundle ${bundleId}. Mint: ${results.mintAddress}`;
        console.log(results.message);
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
    targetWalletNames // Optional: array of specific child wallet names to use (must be eligible)
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
        const allChildWallets = await loadChildWalletsFromFile(CHILD_WALLETS_FILE);
        if (!allChildWallets || allChildWallets.length === 0) {
            throw new Error("No child wallets found.");
        }

        // Filter for eligible wallets
        let eligibleWallets = allChildWallets.filter(wallet => {
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

        const lamportsPerWallet = solAmountPerWallet * LAMPORTS_PER_SOL;
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
                    solSpendPerWallet: solAmountPerWallet 
                })) {
                    throw new Error(`Insufficient SOL balance in one or more wallets for batch ${i + 1} (including rent exemption requirements).`);
                }

                const bundledTxArgs = [];
                const walletSignerMap = [];

                batch.forEach((wallet, index) => {
                    bundledTxArgs.push({
                        publicKey: wallet.publicKey,
                        action: "buy",
                        mint: mintAddress,
                        denominatedInSol: "true",
                        amount: lamportsPerWallet.toString(),
                        slippage: slippageBps.toString(),
                        priorityFee: (index === 0 ? DEFAULT_JITO_TIP_VIA_PUMP_PORTAL_PRIORITY_FEE : DEFAULT_PUMP_PORTAL_NOMINAL_SUBSEQUENT_TX_FEE_SOL) * LAMPORTS_PER_SOL,
                        pool: "pump",
                    });
                    walletSignerMap.push({ wallet, isCreate: false });
                });

                const rawTransactionsFromApi = await getTransactionsFromPumpPortal(bundledTxArgs);
                if (rawTransactionsFromApi.length !== bundledTxArgs.length) {
                    throw new Error(`Mismatch in transactions from Pump Portal for batch ${i + 1}.`);
                }

                const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(connection);
                const walletKeypairsForSigning = walletSignerMap.map(item => item.wallet); 

                // MONOCODE Fix: Pass full blockhash data to match working test pattern
                const recentBlockhashData = { blockhash, lastValidBlockHeight };
                
                const { signedEncodedTransactions, primarySignatures } = await preparePumpTransactionsForJito(
                    rawTransactionsFromApi,
                    walletKeypairsForSigning,
                    recentBlockhashData, // Pass full blockhash data
                    null // No mintKeypair for buys
                );
                
                rawTransactionsFromApi.forEach((tx, idx) => {
                    batchBundleResult.transactions.push({
                        walletName: walletSignerMap[idx].wallet.name,
                        action: "buy",
                        rawTx: tx,
                        signedTx: signedEncodedTransactions[idx]
                    });
                });

                console.log(`Sending ${signedEncodedTransactions.length}-TX Jito bundle for batch ${i + 1}...`);
                const bundleId = await sendJitoBundleWithRetries(signedEncodedTransactions);
                batchBundleResult.bundleId = bundleId;
                console.log(`Batch ${i + 1} bundle sent with ID: ${bundleId}`);

                // WebSocket Bundle Confirmation - MONOCODE Fix: Avoid Jito rate limiting
                console.log(`[PumpService] Waiting for batch ${i + 1} bundle confirmation via WebSocket on first signature: ${primarySignatures[0].slice(0, 8)}...`);
                try {
                    await waitForBundleViaWebSocket(connection, primarySignatures[0], 'confirmed');
                    batchBundleResult.success = true;
                    batchBundleResult.message = `Batch ${i + 1} buy successful.`;
                    overallResult.successfulBundles++;
                    console.log(`[PumpService] ✅ Batch ${i + 1} bundle confirmed successfully via WebSocket!`);
                } catch (error) {
                    throw new Error(`Bundle ${bundleId} for batch ${i + 1} WebSocket confirmation failed: ${error.message}`);
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
    slippageBps = 2500
) {
    const connection = getSolanaConnection();
    const result = {
        success: false,
        message: '',
        mintAddress: mintAddress,
        bundleId: null,
        transactions: []
    };

    try {
        const allChildWallets = await loadChildWalletsFromFile(CHILD_WALLETS_FILE);
        const devWallet = allChildWallets.find(w => w.name === DEV_WALLET_NAME);
        if (!devWallet) {
            throw new Error("DevWallet not found in childWallets.json.");
        }

        console.log(`Attempting to sell ${sellAmountPercentage} of ${mintAddress} from DevWallet (${devWallet.publicKey}).`);

        // DevWallet is the tipper for this single transaction bundle
        if (!await checkWalletBalancesForTokenOperations([{ ...devWallet, isTipper: true }], { 
            solSpendPerWallet: 0 // Selling tokens doesn't require SOL spend, but may need rent for ATAs
        })) {
            throw new Error("Insufficient SOL balance in DevWallet to cover transaction and Jito tip (including rent exemption requirements).");
        }

        const bundledTxArgs = [{
            publicKey: devWallet.publicKey,
            action: "sell",
            mint: mintAddress,
            denominatedInSol: "false", // Selling tokens
            amount: sellAmountPercentage, // Pump Portal API supports percentage string like "50%"
            slippage: slippageBps.toString(),
            priorityFee: DEFAULT_JITO_TIP_VIA_PUMP_PORTAL_PRIORITY_FEE * LAMPORTS_PER_SOL,
            pool: "pump",
        }];
        
        const walletSignerMap = [{ wallet: devWallet, isCreate: false }];

        const rawTransactionsFromApi = await getTransactionsFromPumpPortal(bundledTxArgs);
        if (rawTransactionsFromApi.length !== 1) {
            throw new Error("Expected 1 transaction from Pump Portal for dev sell.");
        }

        const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(connection);
        const walletKeypairsForSigning = walletSignerMap.map(item => item.wallet);

        // MONOCODE Fix: Pass full blockhash data to match working test pattern
        const recentBlockhashData = { blockhash, lastValidBlockHeight };

        const { signedEncodedTransactions, primarySignatures } = await preparePumpTransactionsForJito(
            rawTransactionsFromApi,
            walletKeypairsForSigning,
            recentBlockhashData, // Pass full blockhash data
            null // No mintKeypair for sells
        );

        result.transactions.push({
            walletName: devWallet.name,
            action: "sell",
            rawTx: rawTransactionsFromApi[0],
            signedTx: signedEncodedTransactions[0]
        });

        console.log(`Sending 1-TX Jito bundle for DevWallet sell...`);
        const bundleId = await sendJitoBundleWithRetries(signedEncodedTransactions);
        result.bundleId = bundleId;
        console.log(`DevWallet sell bundle sent with ID: ${bundleId}`);

        // WebSocket Bundle Confirmation - MONOCODE Fix: Avoid Jito rate limiting
        console.log(`[PumpService] Waiting for DevWallet sell bundle confirmation via WebSocket on first signature: ${primarySignatures[0].slice(0, 8)}...`);
        try {
            await waitForBundleViaWebSocket(connection, primarySignatures[0], 'confirmed');
            result.success = true;
            result.message = `DevWallet successfully sold ${sellAmountPercentage} of ${mintAddress}. Bundle ID: ${bundleId}`;
            console.log(`[PumpService] ✅ DevWallet sell bundle confirmed successfully via WebSocket!`);
        } catch (error) {
            throw new Error(`DevWallet sell bundle ${bundleId} WebSocket confirmation failed: ${error.message}`);
        }

    } catch (error) {
        console.error("Error in devSellService:", error);
        result.message = error.message;
        result.success = false;
    }
    return result;
}

/**
 * Service for batch selling tokens from all child wallets (excluding DevWallet).
 * Sells in batches of up to MAX_WALLETS_PER_BUNDLE wallets per Jito bundle.
 */
async function batchSellService(
    mintAddress,
    sellAmountPercentage, // e.g., "50%" or "100%"
    slippageBps = 2500,
    targetWalletNames // Optional: array of specific child wallet names to use (must be eligible)
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
        const allChildWallets = await loadChildWalletsFromFile(CHILD_WALLETS_FILE);
        if (!allChildWallets || allChildWallets.length === 0) {
            throw new Error("No child wallets found.");
        }

        // Filter for eligible wallets (exclude DevWallet by default)
        let eligibleWallets = allChildWallets.filter(wallet => wallet.name !== DEV_WALLET_NAME);

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

                const bundledTxArgs = [];
                const walletSignerMap = [];

                batch.forEach((wallet, index) => {
                    bundledTxArgs.push({
                        publicKey: wallet.publicKey,
                        action: "sell",
                        mint: mintAddress,
                        denominatedInSol: "false", // Selling tokens
                        amount: sellAmountPercentage,
                        slippage: slippageBps.toString(),
                        priorityFee: (index === 0 ? DEFAULT_JITO_TIP_VIA_PUMP_PORTAL_PRIORITY_FEE : DEFAULT_PUMP_PORTAL_NOMINAL_SUBSEQUENT_TX_FEE_SOL) * LAMPORTS_PER_SOL,
                        pool: "pump",
                    });
                    walletSignerMap.push({ wallet, isCreate: false });
                });

                const rawTransactionsFromApi = await getTransactionsFromPumpPortal(bundledTxArgs);
                if (rawTransactionsFromApi.length !== bundledTxArgs.length) {
                    throw new Error(`Mismatch in transactions from Pump Portal for batch ${i + 1}.`);
                }

                const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(connection);
                const walletKeypairsForSigning = walletSignerMap.map(item => item.wallet);

                // MONOCODE Fix: Pass full blockhash data to match working test pattern
                const recentBlockhashData = { blockhash, lastValidBlockHeight };

                const { signedEncodedTransactions, primarySignatures } = await preparePumpTransactionsForJito(
                    rawTransactionsFromApi,
                    walletKeypairsForSigning,
                    recentBlockhashData, // Pass full blockhash data
                    null // No mintKeypair for sells
                );
                
                rawTransactionsFromApi.forEach((tx, idx) => {
                    batchBundleResult.transactions.push({
                        walletName: walletSignerMap[idx].wallet.name,
                        action: "sell",
                        rawTx: tx,
                        signedTx: signedEncodedTransactions[idx]
                    });
                });

                console.log(`Sending ${signedEncodedTransactions.length}-TX Jito bundle for batch ${i + 1}...`);
                const bundleId = await sendJitoBundleWithRetries(signedEncodedTransactions);
                batchBundleResult.bundleId = bundleId;
                console.log(`Batch ${i + 1} bundle sent with ID: ${bundleId}`);

                // WebSocket Bundle Confirmation - MONOCODE Fix: Avoid Jito rate limiting
                console.log(`[PumpService] Waiting for batch ${i + 1} sell bundle confirmation via WebSocket on first signature: ${primarySignatures[0].slice(0, 8)}...`);
                try {
                    await waitForBundleViaWebSocket(connection, primarySignatures[0], 'confirmed');
                    batchBundleResult.success = true;
                    batchBundleResult.message = `Batch ${i + 1} sell successful.`;
                    overallResult.successfulBundles++;
                    console.log(`[PumpService] ✅ Batch ${i + 1} sell bundle confirmed successfully via WebSocket!`);
                } catch (error) {
                    throw new Error(`Bundle ${bundleId} for batch ${i + 1} WebSocket confirmation failed: ${error.message}`);
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
            overallResult.message = `All ${overallResult.successfulBundles} batch sell bundles confirmed successfully.`;
        } else if (overallResult.totalBundlesSent > 0) {
            overallResult.message = `Batch sell process completed with ${overallResult.successfulBundles} successful and ${overallResult.failedBundles} failed bundles out of ${overallResult.totalBundlesSent}.`;
        } else {
            overallResult.message = "No batches were processed.";
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
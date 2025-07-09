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
const { 
    uploadMetadataToPumpPortal, 
    getTransactionsFromPumpPortal, 
    preparePumpTransactionsForJito,
    DEFAULT_JITO_TIP_VIA_PUMP_PORTAL_PRIORITY_FEE,
    DEFAULT_PUMP_PORTAL_NOMINAL_SUBSEQUENT_TX_FEE_SOL
} = require('../utils/pumpAndJitoUtils');
const { sendJitoBundleWithRetries, pollBundleStatus, sleep, getRecentBlockhash } = require('../utils/transactionUtils');

const DEV_WALLET_NAME = "DevWallet";
const FIRST_BUNDLED_BASE_NAME = "First Bundled Wallet";
const MAX_BUYERS_IN_CREATE_BUNDLE = 4; // DevWallet + 4 First Bundled Wallets = 5 TXs max for create bundle
const MAX_WALLETS_PER_BUNDLE = 5; // Max transactions per Jito bundle for batch operations

const MIN_SOL_BALANCE_TIPPER = 0.055;
const MIN_SOL_BALANCE_NON_TIPPER = 0.025;

// Placeholder for where to save the mint address, similar to latestMint_05script_2tx.txt
const LATEST_MINT_FILE = path.join(process.cwd(), 'data', 'latestMint_API.txt'); 

/**
 * Validates SOL balances for wallets involved in a bundle.
 * @param {object[]} wallets - Array of wallet objects { name, publicKey, keypair, isTipper }
 * @param {web3.Connection} connection
 * @returns {Promise<boolean>} True if all balances are sufficient, false otherwise.
 */
async function checkWalletBalances(wallets, connection) {
    for (const wallet of wallets) {
        const balance = await getWalletBalance(connection, wallet.keypair.publicKey);
        const minBalance = wallet.isTipper ? MIN_SOL_BALANCE_TIPPER : MIN_SOL_BALANCE_NON_TIPPER;
        console.log(`Wallet ${wallet.name} (${wallet.keypair.publicKey.toBase58()}) balance: ${balance} SOL. Required: ${minBalance} SOL.`);
        if (balance < minBalance) {
            console.error(`Insufficient balance for ${wallet.name}. Has ${balance}, needs ${minBalance}.`);
            return false;
        }
    }
    return true;
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
                const keypair = Keypair.fromSecretKey(bs58.decode(wallet.privateKey));
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

        if (!await checkWalletBalances(uniqueWalletsForBalanceCheck, connection)) {
            throw new Error("Insufficient SOL balance in one or more participating wallets.");
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
        const { blockhash } = await getRecentBlockhash(connection);
        
        const walletKeypairsForSigning = walletSignerMap.map(item => ({
            name: item.wallet.name,
            keypair: item.wallet.keypair, // Assuming keypair is loaded in childWallets
            publicKey: item.wallet.publicKey
        }));

        const signedEncodedTransactions = await preparePumpTransactionsForJito(
            rawTransactionsFromApi,
            walletKeypairsForSigning, // This expects array of {name, keypair, publicKey}
            blockhash,
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

        // 8. Poll Bundle Status
        const bundleConfirmed = await pollBundleStatus(bundleId);
        if (bundleConfirmed) {
            results.success = true;
            results.message = `Token ${tokenMetadata.symbol} created and initial buys completed successfully in bundle ${bundleId}. Mint: ${results.mintAddress}`;
            console.log(results.message);
            // Save mint address
            await fs.mkdir(path.dirname(LATEST_MINT_FILE), { recursive: true });
            await fs.writeFile(LATEST_MINT_FILE, results.mintAddress);
            console.log(`Saved new mint address to ${LATEST_MINT_FILE}`);
        } else {
            throw new Error(`Bundle ${bundleId} did not confirm or failed.`);
        }

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
                if (!await checkWalletBalances(walletsForBalanceCheck, connection)) {
                    throw new Error(`Insufficient SOL balance in one or more wallets for batch ${i + 1}.`);
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

                const { blockhash } = await getRecentBlockhash(connection);
                const walletKeypairsForSigning = walletSignerMap.map(item => item.wallet); 

                const signedEncodedTransactions = await preparePumpTransactionsForJito(
                    rawTransactionsFromApi,
                    walletKeypairsForSigning,
                    blockhash,
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

                const bundleConfirmed = await pollBundleStatus(bundleId);
                if (bundleConfirmed) {
                    batchBundleResult.success = true;
                    batchBundleResult.message = `Batch ${i + 1} buy successful.`;
                    overallResult.successfulBundles++;
                    console.log(batchBundleResult.message);
                } else {
                    throw new Error(`Bundle ${bundleId} for batch ${i + 1} did not confirm or failed.`);
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
        if (!await checkWalletBalances([{ ...devWallet, isTipper: true }], connection)) {
            throw new Error("Insufficient SOL balance in DevWallet to cover transaction and Jito tip.");
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

        const { blockhash } = await getRecentBlockhash(connection);
        const walletKeypairsForSigning = walletSignerMap.map(item => item.wallet);

        const signedEncodedTransactions = await preparePumpTransactionsForJito(
            rawTransactionsFromApi,
            walletKeypairsForSigning,
            blockhash,
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

        const bundleConfirmed = await pollBundleStatus(bundleId);
        if (bundleConfirmed) {
            result.success = true;
            result.message = `DevWallet successfully sold ${sellAmountPercentage} of ${mintAddress}. Bundle ID: ${bundleId}`;
            console.log(result.message);
        } else {
            throw new Error(`DevWallet sell bundle ${bundleId} did not confirm or failed.`);
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
                if (!await checkWalletBalances(walletsForBalanceCheck, connection)) {
                    throw new Error(`Insufficient SOL balance in one or more wallets for batch ${i + 1}.`);
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

                const { blockhash } = await getRecentBlockhash(connection);
                const walletKeypairsForSigning = walletSignerMap.map(item => item.wallet);

                const signedEncodedTransactions = await preparePumpTransactionsForJito(
                    rawTransactionsFromApi,
                    walletKeypairsForSigning,
                    blockhash,
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

                const bundleConfirmed = await pollBundleStatus(bundleId);
                if (bundleConfirmed) {
                    batchBundleResult.success = true;
                    batchBundleResult.message = `Batch ${i + 1} sell successful.`;
                    overallResult.successfulBundles++;
                    console.log(batchBundleResult.message);
                } else {
                    throw new Error(`Bundle ${bundleId} for batch ${i + 1} did not confirm or failed.`);
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
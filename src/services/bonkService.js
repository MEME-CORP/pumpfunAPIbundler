/**
 * BONK SERVICE - Token Creation and Trading Operations for Bonk Pool
 * 
 * ✅ BONK POOL: This service handles Bonk pool operations via Pump Portal API
 * - Token creation uses Lightning API with external IPFS (nft-storage.letsbonk22.workers.dev)
 * - Buy/Sell operations use local transactions with pool: "bonk" parameter
 * - Transactions are executed in parallel batches of 4 with 0.0005 SOL priority fee
 * 
 * MONOCODE Compliance: Observable implementation with structured logging,
 * explicit error handling, and dependency transparency.
 */

const web3 = require('@solana/web3.js');
const bs58 = require('bs58');
const fs = require('fs').promises; // Still needed for LATEST_MINT_FILE operations
const path = require('path'); // Still needed for LATEST_MINT_FILE path
const fetch = require('node-fetch');
const FormData = require('form-data');
const { Keypair, SystemProgram, LAMPORTS_PER_SOL } = web3;
const { 
    loadKeypairFromFile, 
    loadChildWalletsFromFile, 
    getWalletBalance, 
    getTokenBalance, // MONOCODE: Add getTokenBalance for SPL token balance validation
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
const { 
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

// Bonk-specific constants
const BONK_IPFS_IMG_ENDPOINT = 'https://nft-storage.letsbonk22.workers.dev/upload/img';
const BONK_IPFS_META_ENDPOINT = 'https://nft-storage.letsbonk22.workers.dev/upload/meta';
const PUMP_PORTAL_TRADE_ENDPOINT = 'https://pumpportal.fun/api/trade';

// Placeholder for where to save the mint address, similar to latestMint_05script_2tx.txt
const LATEST_MINT_FILE = path.join(process.cwd(), 'data', 'latestMint_BONK_API.txt'); 

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
    
    console.log(`[BonkService] Validating ${wallets.length} wallets for token operations (may create ATAs)`);
    
    // Group wallets by tipper status for more accurate validation
    const tippers = wallets.filter(w => w.isTipper);
    const nonTippers = wallets.filter(w => !w.isTipper);
    
    let allValid = true;
    
    // Validate tippers (higher requirements due to Jito tips)
    if (tippers.length > 0) {
        console.log(`[BonkService] Validating ${tippers.length} tipper wallet(s)...`);
        const tipperValidation = await validateWalletsForTokenOperations(tippers, {
            solSpendPerWallet: solSpendPerWallet,
            mayCreateTokenAccounts: true,
            isTipper: true
        });
        
        if (!tipperValidation.overallValid) {
            console.error(`[BonkService] ❌ ${tipperValidation.summary.invalidCount} tipper wallet(s) have insufficient balance`);
            for (const invalid of tipperValidation.invalidWallets) {
                if (invalid.validation && invalid.validation.shortfall) {
                    console.error(`[BonkService]   ${invalid.name}: needs ${invalid.validation.shortfall.toFixed(8)} more SOL (has ${invalid.balance}, needs ${invalid.validation.totalRequired.toFixed(8)})`);
                }
            }
            allValid = false;
        }
    }
    
    // Validate non-tippers
    if (nonTippers.length > 0) {
        console.log(`[BonkService] Validating ${nonTippers.length} non-tipper wallet(s)...`);
        const nonTipperValidation = await validateWalletsForTokenOperations(nonTippers, {
            solSpendPerWallet: solSpendPerWallet,
            mayCreateTokenAccounts: true,
            isTipper: false
        });
        
        if (!nonTipperValidation.overallValid) {
            console.error(`[BonkService] ❌ ${nonTipperValidation.summary.invalidCount} non-tipper wallet(s) have insufficient balance`);
            for (const invalid of nonTipperValidation.invalidWallets) {
                if (invalid.validation && invalid.validation.shortfall) {
                    console.error(`[BonkService]   ${invalid.name}: needs ${invalid.validation.shortfall.toFixed(8)} more SOL (has ${invalid.balance}, needs ${invalid.validation.totalRequired.toFixed(8)})`);
                }
            }
            allValid = false;
        }
    }
    
    return allValid;
}

/**
 * Uploads image to Bonk's IPFS service and creates metadata
 * @param {object} tokenMetadata - Token metadata
 * @param {object} imageData - Image buffer and metadata
 * @returns {Promise<string>} Metadata URI
 */
async function uploadToBonkIPFS(tokenMetadata, imageData) {
    console.log(`[BonkService] Uploading image to Bonk IPFS service...`);
    
    try {
        // Upload image to Bonk IPFS
        const formData = new FormData();
        formData.append('image', imageData.buffer, {
            filename: imageData.fileName,
            contentType: imageData.mimetype
        });

        const imgResponse = await fetch(BONK_IPFS_IMG_ENDPOINT, {
            method: 'POST',
            body: formData
        });

        if (!imgResponse.ok) {
            throw new Error(`Image upload failed: ${imgResponse.status} ${imgResponse.statusText}`);
        }

        const imgUri = await imgResponse.text();
        console.log(`[BonkService] Image uploaded to IPFS: ${imgUri}`);

        // Create metadata
        const metadataPayload = {
            createdOn: "https://bonk.fun",
            description: tokenMetadata.description || "Token created via Bonk pool",
            image: imgUri,
            name: tokenMetadata.name,
            symbol: tokenMetadata.symbol,
            website: tokenMetadata.website || "https://pumpportal.fun"
        };

        const metadataResponse = await fetch(BONK_IPFS_META_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(metadataPayload)
        });

        if (!metadataResponse.ok) {
            throw new Error(`Metadata upload failed: ${metadataResponse.status} ${metadataResponse.statusText}`);
        }

        const metadataUri = await metadataResponse.text();
        console.log(`[BonkService] Metadata uploaded to IPFS: ${metadataUri}`);

        return metadataUri;

    } catch (error) {
        console.error(`[BonkService] ❌ Failed to upload to Bonk IPFS:`, error);
        throw error;
    }
}

/**
 * Creates a Bonk token using Lightning API
 * @param {object} tokenMetadata - Token metadata
 * @param {string} metadataUri - IPFS metadata URI
 * @param {web3.Keypair} mintKeypair - Token mint keypair
 * @param {string} devWalletApiKey - Lightning API key for dev wallet (replaces private key)
 * @param {number} devBuyAmount - Dev buy amount in SOL
 * @param {number} slippage - Slippage in basis points
 * @returns {Promise<string>} Transaction signature
 */
async function createBonkTokenViaLightning(tokenMetadata, metadataUri, mintKeypair, devWalletApiKey, devBuyAmount, slippage) {
    console.log(`[BonkService] Creating Bonk token via Lightning API...`);
    
    try {
        if (!devWalletApiKey) {
            throw new Error('Dev wallet API key is required for Bonk token creation via Lightning API');
        }

        const requestBody = {
            action: "create",
            tokenMetadata: {
                name: tokenMetadata.name,
                symbol: tokenMetadata.symbol,
                uri: metadataUri
            },
            mint: bs58.encode(mintKeypair.secretKey),
            denominatedInSol: "true",
            amount: devBuyAmount,
            slippage: slippage / 100, // Convert basis points to percentage
            priorityFee: 0.00005,
            pool: "bonk"
        };

        console.log(`[BonkService] Sending Lightning API request for token creation...`);
        const response = await fetch(`${PUMP_PORTAL_TRADE_ENDPOINT}?api-key=${devWalletApiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Lightning API request failed: ${response.status} ${response.statusText} - ${errorText}`);
        }

        const data = await response.json();
        console.log(`[BonkService] ✅ Bonk token created via Lightning API: ${data.signature}`);
        
        return data.signature;

    } catch (error) {
        console.error(`[BonkService] ❌ Failed to create Bonk token via Lightning API:`, error);
        throw error;
    }
}

/**
 * Service to create a Bonk token and perform initial buys using Lightning API for creation
 * and local transactions for buy operations.
 * 
 * @param {object} tokenMetadata - Token metadata
 * @param {object} imageData - Image buffer and metadata
 * @param {array} wallets - Array of wallet objects
 * @param {object} buyAmountsSOL - Buy amounts for each wallet
 * @param {number} slippageBps - Slippage in basis points
 * @param {string} devWalletApiKey - Lightning API key for dev wallet (replaces private key for creation)
 * @returns {Promise<object>} Result object with transaction details
 */
async function bonkCreateAndBuyService(tokenMetadata, imageData, wallets, buyAmountsSOL, slippageBps = 2500, devWalletApiKey) {
    console.log(`[BonkService] 🚀 Starting Bonk token creation and buy service for ${tokenMetadata.symbol}`);
    
    try {
        // Generate mint keypair
        const mintKeypair = Keypair.generate();
        const mintAddress = mintKeypair.publicKey.toBase58();
        console.log(`[BonkService] Generated mint address: ${mintAddress}`);

        // Process wallets
        const processedWallets = wallets.map(wallet => {
            const keypair = Keypair.fromSecretKey(bs58Decoder.decode(wallet.privateKey));
            return {
                name: wallet.name,
                publicKey: keypair.publicKey.toBase58(),
                keypair: keypair,
                isTipper: wallet.name === DEV_WALLET_NAME // Only DevWallet tips
            };
        });

        // Find DevWallet
        const devWallet = processedWallets.find(w => w.name === DEV_WALLET_NAME);
        if (!devWallet) {
            throw new Error('DevWallet not found in provided wallets');
        }

        // Upload to Bonk IPFS if image provided
        let metadataUri;
        if (imageData && imageData.buffer) {
            metadataUri = await uploadToBonkIPFS(tokenMetadata, imageData);
        } else {
            // Create basic metadata without image
            const metadataPayload = {
                createdOn: "https://bonk.fun",
                description: tokenMetadata.description || "Token created via Bonk pool",
                name: tokenMetadata.name,
                symbol: tokenMetadata.symbol,
                website: tokenMetadata.website || "https://pumpportal.fun"
            };

            const metadataResponse = await fetch(BONK_IPFS_META_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(metadataPayload)
            });

            if (!metadataResponse.ok) {
                throw new Error(`Metadata upload failed: ${metadataResponse.status} ${metadataResponse.statusText}`);
            }

            metadataUri = await metadataResponse.text();
            console.log(`[BonkService] Metadata uploaded without image: ${metadataUri}`);
        }

        // Create token via Lightning API
        const devBuyAmount = tokenMetadata.createAmountSOL || 0.5;
        const createSignature = await createBonkTokenViaLightning(
            tokenMetadata,
            metadataUri,
            mintKeypair,
            devWalletApiKey,
            devBuyAmount,
            slippageBps
        );

        // Wait for token creation to be confirmed
        console.log(`[BonkService] Waiting for token creation confirmation...`);
        await sleep(3000); // Wait 3 seconds for token to be created

        // Prepare buy transactions for other wallets
        const buyTransactions = [];
        const buyWallets = processedWallets.filter(w => w.name !== DEV_WALLET_NAME);

        for (const wallet of buyWallets) {
            const buyAmountKey = `${wallet.name.toLowerCase().replace(/\s+/g, '')}BuySOL`;
            const buyAmount = buyAmountsSOL[buyAmountKey];
            
            if (buyAmount && buyAmount > 0) {
                buyTransactions.push({
                    wallet: wallet,
                    amount: buyAmount,
                    action: 'buy'
                });
                console.log(`[BonkService] Prepared buy transaction: ${wallet.name} - ${buyAmount} SOL`);
            }
        }

        // Execute buy transactions in parallel if any
        let buySignatures = [];
        if (buyTransactions.length > 0) {
            console.log(`[BonkService] Executing ${buyTransactions.length} buy transactions in parallel...`);
            
            const buyRequests = buyTransactions.map(tx => ({
                action: 'buy',
                mintAddress: mintAddress,
                signerKeypair: tx.wallet.keypair,
                amount: tx.amount,
                denominatedInSol: true,
                slippage: slippageBps,
                pool: 'bonk'
            }));

            buySignatures = await executeParallelTransactions(buyRequests);
            console.log(`[BonkService] ✅ Buy transactions completed: ${buySignatures.length} signatures`);

            // Confirm buy transactions
            await confirmParallelTransactions(buySignatures);
            console.log(`[BonkService] ✅ All buy transactions confirmed`);
        }

        // Save mint address to file
        try {
            await fs.writeFile(LATEST_MINT_FILE, mintAddress, 'utf8');
            console.log(`[BonkService] Saved mint address to ${LATEST_MINT_FILE}`);
        } catch (fileError) {
            console.warn(`[BonkService] Failed to save mint address to file:`, fileError.message);
        }

        const result = {
            mintAddress: mintAddress,
            createSignature: createSignature,
            buySignatures: buySignatures,
            metadataUri: metadataUri,
            totalBuyTransactions: buyTransactions.length,
            devBuyAmount: devBuyAmount,
            pool: 'bonk'
        };

        console.log(`[BonkService] ✅ Bonk token creation and buy service completed successfully`);
        return result;

    } catch (error) {
        console.error(`[BonkService] ❌ Error in bonkCreateAndBuyService:`, error);
        throw error;
    }
}

/**
 * Service for batch buying a Bonk token with multiple child wallets using local transactions
 */
async function bonkBatchBuyService(mintAddress, solAmountPerWallet, slippageBps = 2500, targetWalletNames, wallets) {
    console.log(`[BonkService] 🚀 Starting Bonk batch buy service for token ${mintAddress}`);
    
    try {
        // Process wallets
        const processedWallets = wallets.map(wallet => {
            const keypair = Keypair.fromSecretKey(bs58Decoder.decode(wallet.privateKey));
            return {
                name: wallet.name,
                publicKey: keypair.publicKey.toBase58(),
                keypair: keypair,
                isTipper: false // No tipping for batch operations
            };
        });

        // Filter eligible wallets (exclude DevWallet and First Bundled Wallets 1-4)
        const eligibleWallets = processedWallets.filter(wallet => {
            if (wallet.name === DEV_WALLET_NAME) return false;
            if (wallet.name.startsWith(FIRST_BUNDLED_BASE_NAME)) return false;
            return true;
        });

        // Apply target wallet filter if specified
        let walletsToUse = eligibleWallets;
        if (targetWalletNames && targetWalletNames.length > 0) {
            walletsToUse = eligibleWallets.filter(wallet => 
                targetWalletNames.includes(wallet.name)
            );
        }

        if (walletsToUse.length === 0) {
            throw new Error('No eligible wallets found for batch buy operation');
        }

        console.log(`[BonkService] Using ${walletsToUse.length} wallets for batch buy`);

        // Validate wallet balances
        const balancesValid = await checkWalletBalancesForTokenOperations(walletsToUse, {
            solSpendPerWallet: solAmountPerWallet
        });

        if (!balancesValid) {
            throw new Error('Some wallets have insufficient balance for batch buy operation');
        }

        // Prepare buy transactions
        const buyRequests = walletsToUse.map(wallet => ({
            action: 'buy',
            mintAddress: mintAddress,
            signerKeypair: wallet.keypair,
            amount: solAmountPerWallet,
            denominatedInSol: true,
            slippage: slippageBps,
            pool: 'bonk'
        }));

        // Execute buy transactions in parallel batches
        console.log(`[BonkService] Executing ${buyRequests.length} buy transactions in parallel batches...`);
        const buySignatures = await executeParallelTransactions(buyRequests);

        // Confirm transactions
        await confirmParallelTransactions(buySignatures);
        console.log(`[BonkService] ✅ All batch buy transactions confirmed`);

        const result = {
            mintAddress: mintAddress,
            signatures: buySignatures,
            walletsUsed: walletsToUse.length,
            solAmountPerWallet: solAmountPerWallet,
            totalSOLSpent: walletsToUse.length * solAmountPerWallet,
            pool: 'bonk'
        };

        console.log(`[BonkService] ✅ Bonk batch buy service completed successfully`);
        return result;

    } catch (error) {
        console.error(`[BonkService] ❌ Error in bonkBatchBuyService:`, error);
        throw error;
    }
}

/**
 * Service for DevWallet to sell a percentage of Bonk tokens using local transactions
 */
async function bonkDevSellService(mintAddress, sellAmountPercentage, slippageBps = 2500, wallets) {
    console.log(`[BonkService] 🚀 Starting Bonk dev sell service for token ${mintAddress}`);
    
    try {
        // Process wallets and find DevWallet
        const processedWallets = wallets.map(wallet => {
            const keypair = Keypair.fromSecretKey(bs58Decoder.decode(wallet.privateKey));
            return {
                name: wallet.name,
                publicKey: keypair.publicKey.toBase58(),
                keypair: keypair
            };
        });

        const devWallet = processedWallets.find(w => w.name === DEV_WALLET_NAME);
        if (!devWallet) {
            throw new Error('DevWallet not found in provided wallets');
        }

        // Get token balance
        const tokenBalance = await getTokenBalance(devWallet.publicKey, mintAddress);
        if (!tokenBalance || tokenBalance.uiAmount === 0) {
            throw new Error('DevWallet has no tokens to sell');
        }

        // Calculate sell amount
        const percentage = parseFloat(sellAmountPercentage.replace('%', ''));
        const sellAmount = (tokenBalance.uiAmount * percentage) / 100;

        console.log(`[BonkService] DevWallet token balance: ${tokenBalance.uiAmount}`);
        console.log(`[BonkService] Selling ${percentage}% = ${sellAmount} tokens`);

        // Execute sell transaction
        const sellSignature = await executeTradeLocalTransaction(
            'sell',
            mintAddress,
            devWallet.keypair,
            sellAmount,
            false, // denominatedInSol = false (selling tokens)
            slippageBps,
            'bonk' // pool parameter
        );

        // Confirm transaction
        await confirmTransactionViaWebSocket(sellSignature);
        console.log(`[BonkService] ✅ Dev sell transaction confirmed`);

        const result = {
            mintAddress: mintAddress,
            signature: sellSignature,
            tokensSold: sellAmount,
            percentage: percentage,
            devWallet: devWallet.publicKey,
            pool: 'bonk'
        };

        console.log(`[BonkService] ✅ Bonk dev sell service completed successfully`);
        return result;

    } catch (error) {
        console.error(`[BonkService] ❌ Error in bonkDevSellService:`, error);
        throw error;
    }
}

/**
 * Service for batch selling Bonk tokens from all child wallets using local transactions
 */
async function bonkBatchSellService(mintAddress, sellAmountPercentage, slippageBps = 2500, targetWalletNames, wallets) {
    console.log(`[BonkService] 🚀 Starting Bonk batch sell service for token ${mintAddress}`);
    
    try {
        // Process wallets
        const processedWallets = wallets.map(wallet => {
            const keypair = Keypair.fromSecretKey(bs58Decoder.decode(wallet.privateKey));
            return {
                name: wallet.name,
                publicKey: keypair.publicKey.toBase58(),
                keypair: keypair
            };
        });

        // Filter eligible wallets (exclude DevWallet)
        const eligibleWallets = processedWallets.filter(wallet => 
            wallet.name !== DEV_WALLET_NAME
        );

        // Apply target wallet filter if specified
        let walletsToUse = eligibleWallets;
        if (targetWalletNames && targetWalletNames.length > 0) {
            walletsToUse = eligibleWallets.filter(wallet => 
                targetWalletNames.includes(wallet.name)
            );
        }

        if (walletsToUse.length === 0) {
            throw new Error('No eligible wallets found for batch sell operation');
        }

        console.log(`[BonkService] Checking token balances for ${walletsToUse.length} wallets...`);

        // Check token balances and prepare sell transactions
        const sellTransactions = [];
        const percentage = parseFloat(sellAmountPercentage.replace('%', ''));

        for (const wallet of walletsToUse) {
            try {
                const tokenBalance = await getTokenBalance(wallet.publicKey, mintAddress);
                if (tokenBalance && tokenBalance.uiAmount > 0) {
                    const sellAmount = (tokenBalance.uiAmount * percentage) / 100;
                    sellTransactions.push({
                        wallet: wallet,
                        sellAmount: sellAmount,
                        originalBalance: tokenBalance.uiAmount
                    });
                    console.log(`[BonkService] ${wallet.name}: selling ${sellAmount} tokens (${percentage}% of ${tokenBalance.uiAmount})`);
                }
            } catch (balanceError) {
                console.warn(`[BonkService] Could not get token balance for ${wallet.name}:`, balanceError.message);
            }
        }

        if (sellTransactions.length === 0) {
            throw new Error('No wallets have tokens to sell');
        }

        // Prepare sell requests
        const sellRequests = sellTransactions.map(tx => ({
            action: 'sell',
            mintAddress: mintAddress,
            signerKeypair: tx.wallet.keypair,
            amount: tx.sellAmount,
            denominatedInSol: false, // Selling tokens
            slippage: slippageBps,
            pool: 'bonk'
        }));

        // Execute sell transactions in parallel batches
        console.log(`[BonkService] Executing ${sellRequests.length} sell transactions in parallel batches...`);
        const sellSignatures = await executeParallelTransactions(sellRequests);

        // Confirm transactions
        await confirmParallelTransactions(sellSignatures);
        console.log(`[BonkService] ✅ All batch sell transactions confirmed`);

        const result = {
            mintAddress: mintAddress,
            signatures: sellSignatures,
            walletsUsed: sellTransactions.length,
            percentage: percentage,
            totalTokensSold: sellTransactions.reduce((sum, tx) => sum + tx.sellAmount, 0),
            pool: 'bonk'
        };

        console.log(`[BonkService] ✅ Bonk batch sell service completed successfully`);
        return result;

    } catch (error) {
        console.error(`[BonkService] ❌ Error in bonkBatchSellService:`, error);
        throw error;
    }
}

module.exports = {
    bonkCreateAndBuyService,
    bonkBatchBuyService,
    bonkDevSellService,
    bonkBatchSellService
};

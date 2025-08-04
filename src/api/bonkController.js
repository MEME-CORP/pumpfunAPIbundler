const bonkService = require('../services/bonkService');
const fs = require('fs'); // For checking image file path
const path = require('path');

const LATEST_MINT_FILE = path.join(process.cwd(), 'data', 'latestMint_BONK_API.txt'); 

async function bonkCreateAndBuy(req, res) {
    try {
        const {
            name, 
            symbol, 
            description, 
            twitter, 
            telegram, 
            website,
            showName, // boolean
            imageFileName, // uploaded file name, server will map to a path
            devWalletApiKey, // Lightning API key for dev wallet (replaces private key for creation)
        } = req.body;
        
        // Parse numeric fields from multipart form data (they come as strings)
        let createAmountSOL = req.body.createAmountSOL;
        let slippageBps = req.body.slippageBps;
        
        // Convert createAmountSOL to number if provided
        if (createAmountSOL !== undefined) {
            createAmountSOL = parseFloat(createAmountSOL);
            if (isNaN(createAmountSOL) || createAmountSOL <= 0) {
                return res.status(400).json({ message: 'Invalid createAmountSOL: must be a positive number.' });
            }
        }
        
        // Convert slippageBps to number if provided
        if (slippageBps !== undefined) {
            slippageBps = parseInt(slippageBps);
            if (isNaN(slippageBps) || slippageBps <= 0) {
                return res.status(400).json({ message: 'Invalid slippageBps: must be a positive integer.' });
            }
        }
        
        // Log parsed numeric values for debugging
        console.log(`[BonkController] Parsed numeric fields: createAmountSOL=${createAmountSOL}, slippageBps=${slippageBps}`);

        // MONOCODE Compliance: Handle multipart/form-data parsing for JSON fields
        // In multipart requests, JSON objects and arrays arrive as strings and need parsing
        let { buyAmountsSOL, wallets } = req.body;
        
        if (buyAmountsSOL && typeof buyAmountsSOL === 'string') {
            try {
                buyAmountsSOL = JSON.parse(buyAmountsSOL);
                console.log(`[BonkController] Parsed buyAmountsSOL from multipart string:`, buyAmountsSOL);
            } catch (parseError) {
                console.error(`[BonkController] Failed to parse buyAmountsSOL JSON string:`, parseError.message);
                return res.status(400).json({ 
                    message: 'Invalid buyAmountsSOL: must be a valid JSON string when using multipart/form-data.',
                    error: parseError.message 
                });
            }
        }
        
        if (wallets && typeof wallets === 'string') {
            try {
                wallets = JSON.parse(wallets);
                console.log(`[BonkController] Parsed wallets from multipart string: ${wallets.length} wallets`);
            } catch (parseError) {
                console.error(`[BonkController] Failed to parse wallets JSON string:`, parseError.message);
                return res.status(400).json({ 
                    message: 'Invalid wallets: must be a valid JSON string when using multipart/form-data.',
                    error: parseError.message 
                });
            }
        }

        // Handle image data from multer
        let imageData = null;
        if (req.file) {
            imageData = {
                buffer: req.file.buffer,
                fileName: req.file.originalname,
                mimetype: req.file.mimetype,
                size: req.file.size
            };
            console.log(`[BonkController] Image uploaded: ${imageData.fileName} (${imageData.size} bytes, ${imageData.mimetype})`);
        } else {
            console.log(`[BonkController] No image uploaded in request`);
        }

        // Validate required fields for Lightning API
        if (!devWalletApiKey) {
            return res.status(400).json({ 
                message: 'devWalletApiKey is required for Bonk token creation via Lightning API' 
            });
        }

        // Prepare token metadata
        const tokenMetadata = {
            name,
            symbol,
            description,
            twitter,
            telegram,
            website,
            showName,
            createAmountSOL
        };

        console.log(`[BonkController] Starting Bonk token creation and buy for ${symbol}`);
        console.log(`[BonkController] Token metadata:`, tokenMetadata);
        console.log(`[BonkController] Buy amounts:`, buyAmountsSOL);
        console.log(`[BonkController] Wallets provided: ${wallets ? wallets.length : 0}`);

        // Call bonkService to create token and execute buys
        const result = await bonkService.bonkCreateAndBuyService(
            tokenMetadata,
            imageData,
            wallets,
            buyAmountsSOL,
            slippageBps,
            devWalletApiKey
        );

        // Save mint address to file for reference
        if (result.mintAddress) {
            try {
                await fs.promises.writeFile(LATEST_MINT_FILE, result.mintAddress, 'utf8');
                console.log(`[BonkController] Saved mint address to ${LATEST_MINT_FILE}: ${result.mintAddress}`);
            } catch (fileError) {
                console.warn(`[BonkController] Failed to save mint address to file:`, fileError.message);
            }
        }

        console.log(`[BonkController] ✅ Bonk token creation and buy completed successfully`);
        res.status(200).json({
            message: 'Bonk token created and initial buys executed successfully',
            data: result
        });

    } catch (error) {
        console.error(`[BonkController] ❌ Error in bonkCreateAndBuy:`, error);
        res.status(500).json({
            message: 'Failed to create Bonk token and execute buys',
            error: error.message
        });
    }
}

async function bonkBatchBuy(req, res) {
    try {
        const { mintAddress, solAmountPerWallet, slippageBps, targetWalletNames, wallets } = req.body;

        if (!mintAddress || !solAmountPerWallet || !wallets) {
            return res.status(400).json({ 
                message: 'Missing required fields: mintAddress, solAmountPerWallet, and wallets are required.' 
            });
        }

        console.log(`[BonkController] Starting Bonk batch buy for token ${mintAddress}`);
        console.log(`[BonkController] Amount per wallet: ${solAmountPerWallet} SOL`);
        console.log(`[BonkController] Target wallets: ${targetWalletNames ? targetWalletNames.length : 'all eligible'}`);
        console.log(`[BonkController] Slippage: ${slippageBps || 2500} bps`);

        const result = await bonkService.bonkBatchBuyService(
            mintAddress,
            solAmountPerWallet,
            slippageBps,
            targetWalletNames,
            wallets
        );

        console.log(`[BonkController] ✅ Bonk batch buy completed successfully`);
        res.status(200).json({
            message: 'Bonk batch buy executed successfully',
            data: result
        });

    } catch (error) {
        console.error(`[BonkController] ❌ Error in bonkBatchBuy:`, error);
        res.status(500).json({
            message: 'Failed to execute Bonk batch buy',
            error: error.message
        });
    }
}

async function bonkDevSell(req, res) {
    try {
        const { mintAddress, sellAmountPercentage, slippageBps, wallets } = req.body;

        if (!mintAddress || !sellAmountPercentage || !wallets) {
            return res.status(400).json({ 
                message: 'Missing required fields: mintAddress, sellAmountPercentage, and wallets are required.' 
            });
        }

        console.log(`[BonkController] Starting Bonk dev sell for token ${mintAddress}`);
        console.log(`[BonkController] Sell percentage: ${sellAmountPercentage}`);
        console.log(`[BonkController] Slippage: ${slippageBps || 2500} bps`);

        const result = await bonkService.bonkDevSellService(
            mintAddress,
            sellAmountPercentage,
            slippageBps,
            wallets
        );

        console.log(`[BonkController] ✅ Bonk dev sell completed successfully`);
        res.status(200).json({
            message: 'Bonk dev sell executed successfully',
            data: result
        });

    } catch (error) {
        console.error(`[BonkController] ❌ Error in bonkDevSell:`, error);
        res.status(500).json({
            message: 'Failed to execute Bonk dev sell',
            error: error.message
        });
    }
}

async function bonkBatchSell(req, res) {
    try {
        const { mintAddress, sellAmountPercentage, slippageBps, targetWalletNames, wallets } = req.body;

        if (!mintAddress || !sellAmountPercentage || !wallets) {
            return res.status(400).json({ 
                message: 'Missing required fields: mintAddress, sellAmountPercentage, and wallets are required.' 
            });
        }

        console.log(`[BonkController] Starting Bonk batch sell for token ${mintAddress}`);
        console.log(`[BonkController] Sell percentage: ${sellAmountPercentage}`);
        console.log(`[BonkController] Target wallets: ${targetWalletNames ? targetWalletNames.length : 'all eligible'}`);
        console.log(`[BonkController] Slippage: ${slippageBps || 2500} bps`);

        const result = await bonkService.bonkBatchSellService(
            mintAddress,
            sellAmountPercentage,
            slippageBps,
            targetWalletNames,
            wallets
        );

        console.log(`[BonkController] ✅ Bonk batch sell completed successfully`);
        res.status(200).json({
            message: 'Bonk batch sell executed successfully',
            data: result
        });

    } catch (error) {
        console.error(`[BonkController] ❌ Error in bonkBatchSell:`, error);
        res.status(500).json({
            message: 'Failed to execute Bonk batch sell',
            error: error.message
        });
    }
}

module.exports = {
    bonkCreateAndBuy,
    bonkBatchBuy,
    bonkDevSell,
    bonkBatchSell
};

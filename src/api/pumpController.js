const pumpService = require('../services/pumpService');
const fs = require('fs'); // For checking image file path
const path = require('path');

const LATEST_MINT_FILE = path.join(process.cwd(), 'data', 'latestMint_API.txt'); 

async function createAndBuy(req, res) {
    try {
        const {
            name, 
            symbol, 
            description, 
            twitter, 
            telegram, 
            website,
            showName, // boolean
            initialSupplyAmount, // string, e.g., "1000000000"
            imageFileName, // uploaded file name, server will map to a path
            slippageBps // number, e.g. 2500 for 25%
        } = req.body;

        // MONOCODE Compliance: Handle multipart/form-data parsing for JSON fields
        // In multipart requests, JSON objects and arrays arrive as strings and need parsing
        let { buyAmountsSOL, wallets } = req.body;
        
        if (buyAmountsSOL && typeof buyAmountsSOL === 'string') {
            try {
                buyAmountsSOL = JSON.parse(buyAmountsSOL);
                console.log(`[PumpController] Parsed buyAmountsSOL from multipart string:`, buyAmountsSOL);
            } catch (parseError) {
                console.error(`[PumpController] Failed to parse buyAmountsSOL JSON string:`, req.body.buyAmountsSOL);
                return res.status(400).json({ 
                    message: 'Invalid JSON format for buyAmountsSOL parameter.',
                    error: 'INVALID_JSON_FORMAT'
                });
            }
        }

        if (wallets && typeof wallets === 'string') {
            try {
                wallets = JSON.parse(wallets);
                console.log(`[PumpController] Parsed wallets from multipart string - count: ${wallets.length}`);
            } catch (parseError) {
                console.error(`[PumpController] Failed to parse wallets JSON string:`, req.body.wallets);
                return res.status(400).json({ 
                    message: 'Invalid JSON format for wallets parameter.',
                    error: 'INVALID_JSON_FORMAT'
                });
            }
        }

        // --- Input Validation ---
        if (!name || !symbol || !description) {
            return res.status(400).json({ message: 'Missing required token metadata: name, symbol, description.' });
        }
        if (!buyAmountsSOL || typeof buyAmountsSOL !== 'object') {
            return res.status(400).json({ message: 'Missing or invalid buyAmountsSOL object.' });
        }
        if (typeof showName === 'undefined') {
             return res.status(400).json({ message: 'showName (boolean) is required.'});
        }
        if (!wallets || !Array.isArray(wallets) || wallets.length === 0) {
            return res.status(400).json({ message: 'A non-empty array of wallets (with name and privateKey) is required.' });
        }

        // Validate wallet structure
        for (const wallet of wallets) {
            if (!wallet.name || !wallet.privateKey) {
                return res.status(400).json({ message: 'Each wallet must have a name and privateKey.' });
            }
        }

        const tokenMetadata = { name, symbol, description, twitter, telegram, website, showName, initialSupplyAmount };
        
        // Handle image upload - Now using multer memory storage
        // MONOCODE Compliance: Explicit Error Handling and Observable Implementation
        let imageData = null;
        
        if (req.file) {
            // MONOCODE Fix: Validate uploaded file has valid content before processing
            if (!req.file.buffer || req.file.size === 0) {
                console.error(`[PumpController] Invalid file upload: ${req.file.originalname} has ${req.file.size} bytes`);
                return res.status(400).json({ 
                    message: 'Invalid file upload: File appears to be empty or corrupted. Please check the file and try again.',
                    error: 'EMPTY_FILE_UPLOAD',
                    details: {
                        fileName: req.file.originalname,
                        fileSize: req.file.size,
                        mimeType: req.file.mimetype
                    }
                });
            }
            
            // Image uploaded via multipart/form-data
            console.log(`[PumpController] Image uploaded: ${req.file.originalname} (${req.file.size} bytes, ${req.file.mimetype})`);
            imageData = {
                buffer: req.file.buffer,
                fileName: req.file.originalname,
                mimetype: req.file.mimetype,
                size: req.file.size
            };
        } else if (imageFileName) {
            // Legacy support for imageFileName parameter (but no filesystem lookup)
            console.warn(`[PumpController] imageFileName parameter provided but no file uploaded. Use multipart/form-data with 'image' field instead.`);
            // We no longer support filesystem lookups for security and stateless operation
        }
        
        if (!imageData) {
            console.log(`[PumpController] No image provided. Proceeding with metadata-only token creation.`);
        }

        const result = await pumpService.createAndBuyService(
            tokenMetadata, 
            imageData, // Pass the image data object (buffer + metadata)
            wallets, // Pass the wallets array instead of loading from file
            buyAmountsSOL, 
            slippageBps
        );

        if (result.success) {
            res.status(200).json({ message: 'Create and buy process completed.', data: result });
        } else {
            // Determine appropriate status code based on error if possible
            res.status(500).json({ message: 'Create and buy process failed.', error: result.message, details: result });
        }

    } catch (error) {
        console.error('[APIError] /api/pump/create-and-buy:', error.message);
        res.status(500).json({ message: 'Error in create-and-buy process.', error: error.message });
    }
}

async function batchBuy(req, res) {
    try {
        let { mintAddress, solAmountPerWallet, slippageBps, targetWalletNames } = req.body;

        if (!mintAddress) {
            // Try to load from LATEST_MINT_FILE if not provided
            try {
                if (fs.existsSync(LATEST_MINT_FILE)) {
                    mintAddress = await fs.promises.readFile(LATEST_MINT_FILE, 'utf-8');
                    mintAddress = mintAddress.trim();
                    console.log(`Using mint address from ${LATEST_MINT_FILE}: ${mintAddress}`);
                } else {
                    return res.status(400).json({ message: 'Missing required parameter: mintAddress, and no fallback mint file found.' });
                }
            } catch (err) {
                console.error(`Error reading latest mint file for batchBuy: ${err.message}`);
                return res.status(500).json({ message: 'Error accessing fallback mint address file.', error: err.message });
            }
        }
        if (!solAmountPerWallet || typeof solAmountPerWallet !== 'number' || solAmountPerWallet <= 0) {
            return res.status(400).json({ message: 'Missing or invalid required parameter: solAmountPerWallet (must be a positive number).' });
        }
        // slippageBps is optional, defaults in service
        // targetWalletNames is optional

        const result = await pumpService.batchBuyService(
            mintAddress,
            solAmountPerWallet,
            slippageBps,
            targetWalletNames
        );

        if (result.success) {
            res.status(200).json({ message: 'Batch buy process completed.', data: result });
        } else {
            res.status(500).json({ message: 'Batch buy process failed.', error: result.message, details: result });
        }

    } catch (error) {
        console.error('[APIError] /api/pump/batch-buy:', error.message);
        res.status(500).json({ message: 'Error in batch-buy process.', error: error.message });
    }
}

async function devSell(req, res) {
    try {
        let { mintAddress, sellAmountPercentage, slippageBps } = req.body;

        // Try to load from LATEST_MINT_FILE if mintAddress not provided
        if (!mintAddress) {
            try {
                if (fs.existsSync(LATEST_MINT_FILE)) {
                    mintAddress = await fs.promises.readFile(LATEST_MINT_FILE, 'utf-8');
                    mintAddress = mintAddress.trim();
                    console.log(`Using mint address from ${LATEST_MINT_FILE}: ${mintAddress}`);
                } else {
                    return res.status(400).json({ message: 'Missing required parameter: mintAddress, and no fallback mint file found.' });
                }
            } catch (err) {
                console.error(`Error reading latest mint file for devSell: ${err.message}`);
                return res.status(500).json({ message: 'Error accessing fallback mint address file.', error: err.message });
            }
        }

        // Validate sellAmountPercentage
        if (!sellAmountPercentage) {
            return res.status(400).json({ message: 'Missing required parameter: sellAmountPercentage.' });
        }

        // Check if sellAmountPercentage is in proper format (e.g., "50%" or "100%")
        if (typeof sellAmountPercentage === 'string') {
            if (!sellAmountPercentage.endsWith('%')) {
                // If it's a string but doesn't end with %, append it
                sellAmountPercentage = `${sellAmountPercentage}%`;
            }
        } else if (typeof sellAmountPercentage === 'number') {
            // If it's a number, convert to string percentage
            if (sellAmountPercentage <= 0 || sellAmountPercentage > 100) {
                return res.status(400).json({ message: 'sellAmountPercentage must be between 1 and 100.' });
            }
            sellAmountPercentage = `${sellAmountPercentage}%`;
        } else {
            return res.status(400).json({ message: 'Invalid sellAmountPercentage format. Must be a percentage string (e.g., "50%") or number between 1-100.' });
        }

        // Call the service
        const result = await pumpService.devSellService(
            mintAddress,
            sellAmountPercentage,
            slippageBps
        );

        if (result.success) {
            res.status(200).json({ message: 'DevWallet sell process completed.', data: result });
        } else {
            res.status(500).json({ message: 'DevWallet sell process failed.', error: result.message, details: result });
        }

    } catch (error) {
        console.error('[APIError] /api/pump/dev-sell:', error.message);
        res.status(500).json({ message: 'Error in DevWallet sell process.', error: error.message });
    }
}

async function batchSell(req, res) {
    try {
        let { mintAddress, sellAmountPercentage, slippageBps, targetWalletNames } = req.body;

        // Try to load from LATEST_MINT_FILE if mintAddress not provided
        if (!mintAddress) {
            try {
                if (fs.existsSync(LATEST_MINT_FILE)) {
                    mintAddress = await fs.promises.readFile(LATEST_MINT_FILE, 'utf-8');
                    mintAddress = mintAddress.trim();
                    console.log(`Using mint address from ${LATEST_MINT_FILE}: ${mintAddress}`);
                } else {
                    return res.status(400).json({ message: 'Missing required parameter: mintAddress, and no fallback mint file found.' });
                }
            } catch (err) {
                console.error(`Error reading latest mint file for batchSell: ${err.message}`);
                return res.status(500).json({ message: 'Error accessing fallback mint address file.', error: err.message });
            }
        }

        // Validate sellAmountPercentage
        if (!sellAmountPercentage) {
            return res.status(400).json({ message: 'Missing required parameter: sellAmountPercentage.' });
        }

        // Check if sellAmountPercentage is in proper format (e.g., "50%" or "100%")
        if (typeof sellAmountPercentage === 'string') {
            if (!sellAmountPercentage.endsWith('%')) {
                // If it's a string but doesn't end with %, append it
                sellAmountPercentage = `${sellAmountPercentage}%`;
            }
        } else if (typeof sellAmountPercentage === 'number') {
            // If it's a number, convert to string percentage
            if (sellAmountPercentage <= 0 || sellAmountPercentage > 100) {
                return res.status(400).json({ message: 'sellAmountPercentage must be between 1 and 100.' });
            }
            sellAmountPercentage = `${sellAmountPercentage}%`;
        } else {
            return res.status(400).json({ message: 'Invalid sellAmountPercentage format. Must be a percentage string (e.g., "50%") or number between 1-100.' });
        }

        // targetWalletNames is optional, validate if provided
        if (targetWalletNames && !Array.isArray(targetWalletNames)) {
            return res.status(400).json({ message: 'targetWalletNames must be an array of wallet names.' });
        }

        // Call the service
        const result = await pumpService.batchSellService(
            mintAddress,
            sellAmountPercentage,
            slippageBps,
            targetWalletNames
        );

        if (result.success) {
            res.status(200).json({ message: 'Batch sell process completed.', data: result });
        } else {
            res.status(500).json({ message: 'Batch sell process failed.', error: result.message, details: result });
        }

    } catch (error) {
        console.error('[APIError] /api/pump/batch-sell:', error.message);
        res.status(500).json({ message: 'Error in batch sell process.', error: error.message });
    }
}

module.exports = {
    createAndBuy,
    batchBuy,
    devSell,
    batchSell
}; 
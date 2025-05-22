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
            buyAmountsSOL, // e.g. { devWalletBuySOL: 0.01, firstBundledWallet1BuySOL: 0.01 }
            slippageBps // number, e.g. 2500 for 25%
        } = req.body;

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

        const tokenMetadata = { name, symbol, description, twitter, telegram, website, showName, initialSupplyAmount };
        
        // Handle image path - Assuming image is uploaded and available at a temp path
        // For a real app, this would come from multer or similar middleware
        let imageFilePath = null;
        if (req.file && req.file.path) { // Example if using multer: req.file.path
            imageFilePath = req.file.path;
        } else if (imageFileName) {
            // This is a placeholder: in a real API, you'd have a secure way to map imageFileName to a server path
            // For now, let's assume it might be a path relative to an 'uploads' folder for testing
            // IMPORTANT: This part needs to be robust and secure in a production environment.
            const tempImagePath = `./uploads/${imageFileName}`; // Example
            try {
                if (fs.existsSync(tempImagePath)) {
                    imageFilePath = tempImagePath;
                } else {
                    console.warn(`Image file ${tempImagePath} not found. Proceeding without image.`);
                }
            } catch (err) {
                console.warn(`Error checking for image file ${tempImagePath}: ${err.message}. Proceeding without image.`);
            }
        }

        const result = await pumpService.createAndBuyService(
            tokenMetadata, 
            imageFilePath, // Pass the resolved path
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
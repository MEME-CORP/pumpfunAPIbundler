const walletService = require('../services/walletService');

async function createOrImportAirdropWallet(req, res) {
    try {
        // For POST, data is in req.body. If privateKey is optional for create, 
        // it might come via query param for GET or be absent.
        // Assuming privateKey for import is sent in req.body
        const { privateKeyBs58 } = req.body; 
        const walletDetails = await walletService.createOrImportMotherWalletService(privateKeyBs58);
        res.status(200).json({ message: 'Airdrop wallet processed successfully.', data: walletDetails });
    } catch (error) {
        console.error('[APIError] /api/wallets/airdrop:', error.message);
        res.status(500).json({ message: 'Error processing airdrop wallet.', error: error.message });
    }
}

async function createBundledWallets(req, res) {
    try {
        const { count, devWalletName, firstBundledWalletBaseName } = req.body;
        if (typeof count !== 'number' || count < 1) {
            return res.status(400).json({ message: 'Invalid input: count must be a number greater than 0.' });
        }
        const walletsDetails = await walletService.createBundledWalletsService(count, devWalletName, firstBundledWalletBaseName);
        res.status(200).json({ message: `${walletsDetails.length} bundled wallets created successfully.`, data: walletsDetails });
    } catch (error) {
        console.error('[APIError] /api/wallets/bundled (create):', error.message);
        res.status(500).json({ message: 'Error creating bundled wallets.', error: error.message });
    }
}

async function importBundledWallets(req, res) {
    try {
        const { wallets } = req.body; // Expects an array like [{name, privateKeyBs58}]
        if (!Array.isArray(wallets) || wallets.length === 0) {
            return res.status(400).json({ message: 'Invalid input: wallets must be a non-empty array.' });
        }
        const walletsDetails = await walletService.importBundledWalletsService(wallets);
        res.status(200).json({ message: `${walletsDetails.length} bundled wallets imported successfully.`, data: walletsDetails });
    } catch (error) {
        console.error('[APIError] /api/wallets/bundled (import):', error.message);
        res.status(500).json({ message: 'Error importing bundled wallets.', error: error.message });
    }
}

async function getWalletBalance(req, res) {
    try {
        const { publicKey } = req.params;
        if (!publicKey) {
            return res.status(400).json({ message: 'Public key parameter is required.'});
        }
        const balanceData = await walletService.getWalletBalanceService(publicKey);
        res.status(200).json({ message: 'Balance retrieved successfully.', data: balanceData });
    } catch (error) {
        console.error(`[APIError] /api/wallets/:publicKey/balance: ${publicKey}`, error.message);
        res.status(500).json({ message: 'Error retrieving wallet balance.', error: error.message });
    }
}

async function fundBundledWallets(req, res) {
    try {
        const { amountPerWalletSOL, targetWalletNames, motherWalletPrivateKeyBs58 } = req.body;
        if (typeof amountPerWalletSOL !== 'number' || amountPerWalletSOL <= 0) {
            return res.status(400).json({ message: 'Invalid input: amountPerWalletSOL must be a positive number.' });
        }
        // targetWalletNames and motherWalletPrivateKeyBs58 are optional
        const results = await walletService.fundChildWalletsService(amountPerWalletSOL, targetWalletNames, motherWalletPrivateKeyBs58);
        res.status(200).json({ message: 'Funding process completed.', data: results });
    } catch (error) {
        console.error('[APIError] /api/wallets/fund-bundled:', error.message);
        res.status(500).json({ message: 'Error funding bundled wallets.', error: error.message });
    }
}

async function returnFundsToMother(req, res) {
    try {
        const { motherWalletPublicKeyBs58, sourceWalletNames } = req.body;
        if (!motherWalletPublicKeyBs58) {
            return res.status(400).json({ message: 'Invalid input: motherWalletPublicKeyBs58 is required.' });
        }
        // sourceWalletNames is optional
        const results = await walletService.returnFundsToMotherWalletService(motherWalletPublicKeyBs58, sourceWalletNames);
        res.status(200).json({ message: 'Return funds process completed.', data: results });
    } catch (error) {
        console.error('[APIError] /api/wallets/return-funds:', error.message);
        res.status(500).json({ message: 'Error returning funds to mother wallet.', error: error.message });
    }
}

module.exports = {
    createOrImportAirdropWallet,
    createBundledWallets,
    importBundledWallets,
    getWalletBalance,
    fundBundledWallets,
    returnFundsToMother,
    // ... other controllers
}; 
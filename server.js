const express = require('express');
const walletController = require('./src/api/walletController');
const pumpController = require('./src/api/pumpController'); // Require the new controller
// const pumpController = require('./src/api/pumpController'); // Placeholder

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json()); // Middleware to parse JSON bodies

// --- Wallet Management Routes ---
app.post('/api/wallets/airdrop', walletController.createOrImportAirdropWallet);

// For bundled wallets, decided to use query params or separate routes for create vs import for clarity
// Option 1: Separate routes (more explicit)
app.post('/api/wallets/bundled/create', walletController.createBundledWallets);
app.post('/api/wallets/bundled/import', walletController.importBundledWallets);

// Option 2: Single route with logic to differentiate (commented out for now)
// app.post('/api/wallets/bundled', (req, res) => {
//     if (req.body.wallets && Array.isArray(req.body.wallets)) {
//         walletController.importBundledWallets(req, res);
//     } else if (typeof req.body.count === 'number') {
//         walletController.createBundledWallets(req, res);
//     } else {
//         res.status(400).json({ message: 'Invalid request for bundled wallets. Provide 'count' for creation or 'wallets' array for import.' });
//     }
// });

app.get('/api/wallets/:publicKey/balance', walletController.getWalletBalance);

// --- Funding Routes ---
app.post('/api/wallets/fund-bundled', walletController.fundBundledWallets);
app.post('/api/wallets/return-funds', walletController.returnFundsToMother);

// --- Pump Portal Trading Routes ---
app.post('/api/pump/create-and-buy', pumpController.createAndBuy);
app.post('/api/pump/batch-buy', pumpController.batchBuy);
app.post('/api/pump/sell-dev', pumpController.devSell);
app.post('/api/pump/batch-sell', pumpController.batchSell);

app.get('/', (req, res) => {
    res.send('PumpFun API Bundler is running!');
});

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});

// Basic error handler (optional, can be more sophisticated)
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
}); 
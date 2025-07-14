const fetch = require('node-fetch');
const bs58 = require('bs58');
const web3 = require('@solana/web3.js');
const { VersionedTransaction, Keypair } = web3;
const { sendJitoBundleWithRetries, pollBundleStatus, sleep } = require('./transactionUtils');
const { getSolanaConnection } = require('./walletUtils');

// Constants for Pump Portal (can be made configurable)
const PUMP_PORTAL_API_URL = 'https://pumpportal.fun/api';
const PUMP_PORTAL_TRADE_LOCAL_ENDPOINT = `${PUMP_PORTAL_API_URL}/trade-local`;
const PUMP_PORTAL_IPFS_ENDPOINT = 'https://pump.fun/api/ipfs'; // MONOCODE Fix: Correct domain for IPFS upload

// Default Jito tip for pump.fun transactions (can be overridden by specific services)
const DEFAULT_JITO_TIP_VIA_PUMP_PORTAL_PRIORITY_FEE = 0.001; // As determined successful
const DEFAULT_PUMP_PORTAL_NOMINAL_SUBSEQUENT_TX_FEE_SOL = 0;

const bs58Decoder = bs58.default || bs58;

/**
 * Uploads metadata (and optionally an image) to Pump Portal's IPFS.
 * @param {object} metadata - The token metadata (name, symbol, description, etc.).
 * @param {Buffer} [imageBuffer] - Optional image buffer.
 * @param {string} [imageFileName] - Optional image file name (e.g., 'token.png').
 * @returns {Promise<string>} The IPFS metadata URI.
 */
async function uploadMetadataToPumpPortal(metadata, imageBuffer, imageFileName) {
    const formData = new FormData();
    formData.append('name', metadata.name);
    formData.append('symbol', metadata.symbol);
    formData.append('description', metadata.description);
    if (metadata.twitter) formData.append('twitter', metadata.twitter);
    if (metadata.telegram) formData.append('telegram', metadata.telegram);
    if (metadata.website) formData.append('website', metadata.website);
    if (metadata.showName) formData.append('showName', metadata.showName.toString()); // true or false

    if (imageBuffer && imageFileName) {
        const { Blob } = await import('buffer'); // Dynamic import for Blob
        formData.append('file', new Blob([imageBuffer]), imageFileName);
    }

    console.log(`Uploading metadata to Pump Portal IPFS: ${JSON.stringify(metadata)}`);
    const response = await fetch(PUMP_PORTAL_IPFS_ENDPOINT, {
        method: 'POST',
        body: formData,
        // Headers are set automatically by node-fetch for FormData
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Pump Portal IPFS upload failed: ${response.status} ${errorText}`);
    }
    const responseData = await response.json();
    if (!responseData.metadataUri) {
        throw new Error('Pump Portal IPFS response did not include metadataUri.');
    }
    console.log(`Metadata uploaded successfully. URI: ${responseData.metadataUri}`);
    return responseData.metadataUri;
}

/**
 * Fetches serialized transactions from Pump Portal's trade-local API.
 * @param {Array<object>} transactionArgs - Array of transaction arguments for Pump Portal.
 * @returns {Promise<Array<string>>} Array of base58 encoded transaction strings.
 */
async function getTransactionsFromPumpPortal(transactionArgs) {
    console.log(`Requesting ${transactionArgs.length} transactions from Pump Portal: ${JSON.stringify(transactionArgs, null, 2)}`);
    const response = await fetch(PUMP_PORTAL_TRADE_LOCAL_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(transactionArgs),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Pump Portal trade-local API request failed: ${response.status} ${errorText}`);
    }
    const responseData = await response.json();
    if (!Array.isArray(responseData) || responseData.length !== transactionArgs.length) {
        throw new Error('Unexpected response format from Pump Portal trade-local API or mismatched transaction count.');
    }
    console.log(`Received ${responseData.length} raw transaction strings from Pump Portal.`);
    return responseData; // Array of base58 encoded tx strings
}

/**
 * Prepares and signs a batch of transactions obtained from Pump Portal.
 * @param {Array<string>} rawTransactionsFromApi - Array of base58 encoded transaction strings from Pump Portal.
 * @param {Array<object>} walletBatch - Array of wallet objects ({ name, keypair, publicKey }) corresponding to each transaction.
 * @param {string} recentBlockhash - The recent blockhash to use for all transactions in the batch.
 * @param {web3.Keypair} [mintKeypair] - Optional. The keypair for the token mint, required for 'create' transactions.
 * @returns {Promise<Array<string>>} Array of base58 encoded *signed* transaction strings for the Jito bundle.
 */
async function preparePumpTransactionsForJito(rawTransactionsFromApi, walletBatch, recentBlockhash, mintKeypair) {
    const signedEncodedTransactions = [];
    const connection = getSolanaConnection(); // Get a connection instance

    for (let i = 0; i < rawTransactionsFromApi.length; i++) {
        const rawTxString = rawTransactionsFromApi[i];
        const wallet = walletBatch[i];
        const txLabel = `TX ${i + 1} (Wallet ${wallet.name} ${wallet.publicKey.substring(0,6)})`;
        console.log(`  Processing ${txLabel}...`);

        try {
            const transactionBytes = bs58Decoder.decode(rawTxString);
            const deserializedTx = VersionedTransaction.deserialize(transactionBytes);
            deserializedTx.message.recentBlockhash = recentBlockhash;

            // Ensure payer is set correctly
            if (!deserializedTx.message.payerKey || deserializedTx.message.payerKey.toBase58() !== wallet.keypair.publicKey.toBase58()){
                console.log(`  ${txLabel}: PayerKey from API was ${deserializedTx.message.payerKey?.toBase58()}, setting to wallet ${wallet.keypair.publicKey.toBase58()}.`);
                deserializedTx.message.payerKey = wallet.keypair.publicKey;
            }

            const signers = [wallet.keypair];
            // Check if this is a create transaction that needs the mintKeypair signature
            // This is a heuristic based on the presence of mintKeypair. A more robust way would be to inspect txArgs if available here.
            if (mintKeypair && deserializedTx.message.instructions.some(ix => {
                // A simple check, real create instruction might be complex.
                // This assumes the create instruction involves the mint public key in its accounts.
                const programId = deserializedTx.message.accountKeys[ix.programIdIndex].toBase58();
                // The actual pump program ID is not fixed/publicly known from their docs for local check.
                // For now, if mintKeypair is provided, we assume it's a create and needs its signature.
                // A more robust check would be to know the program ID or the structure of create instruction.
                return ix.accounts.some(accIndex => deserializedTx.message.accountKeys[accIndex].equals(mintKeypair.publicKey));
            })) {
                console.log(`  ${txLabel}: Identified as a create-like transaction, adding mintKeypair signature.`);
                signers.push(mintKeypair);
            }
            
            deserializedTx.sign(signers);
            console.log(`  ${txLabel} signed. Payer: ${deserializedTx.message.payerKey.toBase58()}, Signatures: ${deserializedTx.signatures.filter(s => s && !s.every(b => b === 0)).length} (valid) of ${signers.length} expected.`);
            
            if (!deserializedTx.signatures[0] || deserializedTx.signatures[0].every(byte => byte === 0)) {
                throw new Error(`Signing ${txLabel} failed or produced an empty primary signature.`);
            }
            // Additional signature check if more signers were expected
            if (signers.length > 1 && (!deserializedTx.signatures[1] || deserializedTx.signatures[1].every(byte => byte === 0))){
                console.warn(`  ${txLabel}: Expected ${signers.length} signatures, but secondary signature might be missing or invalid.`);
                // Depending on strictness, this could be an error.
            }

            signedEncodedTransactions.push(bs58Decoder.encode(deserializedTx.serialize()));
            console.log(`  ${txLabel} prepared for Jito bundle.`);

        } catch (error) {
            console.error(`  Error processing ${txLabel}:`, error.message);
            if (error.stack) console.error(error.stack);
            throw error; // Propagate error to stop batch processing
        }
    }
    return signedEncodedTransactions;
}


module.exports = {
    uploadMetadataToPumpPortal,
    getTransactionsFromPumpPortal,
    preparePumpTransactionsForJito,
    PUMP_PORTAL_API_URL,
    PUMP_PORTAL_TRADE_LOCAL_ENDPOINT,
    PUMP_PORTAL_IPFS_ENDPOINT,
    DEFAULT_JITO_TIP_VIA_PUMP_PORTAL_PRIORITY_FEE,
    DEFAULT_PUMP_PORTAL_NOMINAL_SUBSEQUENT_TX_FEE_SOL
}; 
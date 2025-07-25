const fetch = require('node-fetch');
const bs58 = require('bs58');
const web3 = require('@solana/web3.js');
const { VersionedTransaction, Keypair } = web3;
const { sendJitoBundleWithRetries, pollBundleStatus, sleep } = require('./transactionUtils');
const { getSolanaConnection } = require('./walletUtils');
const FormData = require('form-data'); // MONOCODE Fix: Use form-data package for proper multipart headers with node-fetch v2

// Constants for Pump Portal (can be made configurable)
const PUMP_PORTAL_API_URL = 'https://pumpportal.fun/api';
const PUMP_PORTAL_TRADE_LOCAL_ENDPOINT = `${PUMP_PORTAL_API_URL}/trade-local`;
// MONOCODE Fix: Removed PUMP_PORTAL_IPFS_ENDPOINT - now using Pinata for IPFS uploads

// Default Jito tip for pump.fun transactions (can be overridden by specific services)
const DEFAULT_JITO_TIP_VIA_PUMP_PORTAL_PRIORITY_FEE = 0.0021; // As determined successful
const DEFAULT_PUMP_PORTAL_NOMINAL_SUBSEQUENT_TX_FEE_SOL = 0.00005; // Follow documentation pattern: small fee for subsequent TXs

const bs58Decoder = bs58.default || bs58;

/**
 * Uploads metadata (and optionally an image) to Pinata IPFS.
 * MONOCODE Fix: Switch to Pinata IPFS as pump.fun no longer supports direct IPFS uploads
 * @param {object} metadata - The token metadata (name, symbol, description, etc.).
 * @param {Buffer} [imageBuffer] - Optional image buffer.
 * @param {string} [imageFileName] - Optional image file name (e.g., 'token.png').
 * @returns {Promise<string>} The IPFS metadata URI.
 */
async function uploadMetadataToPumpPortal(metadata, imageBuffer, imageFileName) {
    const pinataJWT = process.env.PINATA_JWT;
    if (!pinataJWT) {
        throw new Error('PINATA_JWT environment variable is required for IPFS uploads');
    }

    console.log(`Uploading metadata to Pinata IPFS: ${JSON.stringify(metadata)}`);
    
    let imageUrl = null;
    
    // Step 1: Upload image to Pinata if provided
    if (imageBuffer && imageFileName) {
        // MONOCODE Fix: Validate image buffer has valid content before uploading to Pinata
        if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
            console.error(`[PumpAndJitoUtils] Invalid image buffer: ${imageFileName} has ${imageBuffer ? imageBuffer.length : 0} bytes`);
            throw new Error(`Invalid image buffer: ${imageFileName} appears to be empty or corrupted`);
        }
        
        try {
            console.log(`Uploading image to Pinata: ${imageFileName} (${imageBuffer.length} bytes)`);
            
            // MONOCODE Fix: Use form-data package for proper multipart headers with node-fetch v2
            const imageFormData = new FormData();
            imageFormData.append('network', 'public');
            imageFormData.append('file', imageBuffer, {
                filename: imageFileName,
                contentType: 'image/jpeg' // Default content type, could be made dynamic
            });
            
            const imageOptions = {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${pinataJWT}`,
                    ...imageFormData.getHeaders() // MONOCODE Fix: Add proper multipart headers
                },
                body: imageFormData
            };
            
            const imageResponse = await fetch('https://uploads.pinata.cloud/v3/files', imageOptions);
            if (!imageResponse.ok) {
                const errorText = await imageResponse.text();
                throw new Error(`Pinata image upload failed: ${imageResponse.status} ${errorText}`);
            }
            
            const imageResult = await imageResponse.json();
            if (!imageResult.data || !imageResult.data.cid) {
                throw new Error('Pinata image upload response missing CID');
            }
            
            imageUrl = `https://ipfs.io/ipfs/${imageResult.data.cid}`;
            console.log(`Image uploaded successfully: ${imageUrl}`);
        } catch (error) {
            console.error('Failed to upload image to Pinata:', error);
            throw new Error(`Image upload failed: ${error.message}`);
        }
    }
    
    // Step 2: Create and upload metadata to Pinata
    try {
        const metadataObject = {
            name: metadata.name,
            symbol: metadata.symbol,
            description: metadata.description,
            twitter: metadata.twitter || '',
            telegram: metadata.telegram || '',
            website: metadata.website || ''
        };
        
        // Add image URL to metadata if image was uploaded
        if (imageUrl) {
            metadataObject.image = imageUrl;
        }
        
        console.log(`Creating metadata file for Pinata upload:`, metadataObject);
        
        // MONOCODE Fix: Use form-data package for proper multipart headers with node-fetch v2
        const metadataFormData = new FormData();
        metadataFormData.append('network', 'public');
        metadataFormData.append('file', JSON.stringify(metadataObject), {
            filename: 'metadata.json',
            contentType: 'application/json'
        });
        
        const metadataOptions = {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${pinataJWT}`,
                ...metadataFormData.getHeaders() // MONOCODE Fix: Add proper multipart headers
            },
            body: metadataFormData
        };
        
        const metadataResponse = await fetch('https://uploads.pinata.cloud/v3/files', metadataOptions);
        if (!metadataResponse.ok) {
            const errorText = await metadataResponse.text();
            throw new Error(`Pinata metadata upload failed: ${metadataResponse.status} ${errorText}`);
        }
        
        const metadataResult = await metadataResponse.json();
        if (!metadataResult.data || !metadataResult.data.cid) {
            throw new Error('Pinata metadata upload response missing CID');
        }
        
        const metadataUri = `https://ipfs.io/ipfs/${metadataResult.data.cid}`;
        console.log(`Metadata uploaded successfully. URI: ${metadataUri}`);
        return metadataUri;
        
    } catch (error) {
        console.error('Failed to upload metadata to Pinata:', error);
        throw new Error(`Metadata upload failed: ${error.message}`);
    }
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
 * @param {Object} recentBlockhashData - The recent blockhash data with blockhash and lastValidBlockHeight.
 * @param {web3.Keypair} [mintKeypair] - Optional. The keypair for the token mint, required for 'create' transactions.
 * @returns {Promise<Object>} Object containing signedEncodedTransactions and primarySignatures arrays.
 */
async function preparePumpTransactionsForJito(rawTransactionsFromApi, walletBatch, recentBlockhashData, mintKeypair) {
    const signedEncodedTransactions = [];
    const primarySignatures = []; // MONOCODE Fix: Track primary signatures for WebSocket confirmation
    const connection = getSolanaConnection(); // Get a connection instance

    console.log(`[PumpAndJitoUtils] Using blockhash: ${recentBlockhashData.blockhash.slice(0, 8)}... Valid until: ${recentBlockhashData.lastValidBlockHeight}`);

    for (let i = 0; i < rawTransactionsFromApi.length; i++) {
        const rawTxString = rawTransactionsFromApi[i];
        const wallet = walletBatch[i];
        const txLabel = `TX ${i + 1} (Wallet ${wallet.name} ${wallet.publicKey.substring(0,6)})`;
        console.log(`  Processing ${txLabel}...`);

        try {
            const transactionBytes = bs58Decoder.decode(rawTxString);
            const deserializedTx = VersionedTransaction.deserialize(transactionBytes);
            
            // MONOCODE Fix: Use full blockhash data matching the working test pattern
            deserializedTx.message.recentBlockhash = recentBlockhashData.blockhash;

            // MONOCODE Fix: Ensure payer is set correctly - critical for transaction validation
            if (!deserializedTx.message.payerKey || deserializedTx.message.payerKey.toBase58() !== wallet.keypair.publicKey.toBase58()) {
                console.log(`  ${txLabel}: PayerKey from API was ${deserializedTx.message.payerKey?.toBase58() || 'undefined'}, setting to wallet ${wallet.keypair.publicKey.toBase58()}.`);
                deserializedTx.message.payerKey = wallet.keypair.publicKey;
            }

            // MONOCODE Fix: Match working test signer order - critical for transaction validation
            let signers = [];
            if (mintKeypair && i === 0) {
                // For create transactions (index 0), match test pattern: [mintKeypair, devWallet.keypair]
                console.log(`  ${txLabel}: Identified as create transaction (index 0), using test pattern signer order: [mintKeypair, wallet.keypair]`);
                signers = [mintKeypair, wallet.keypair];
            } else {
                // For buy transactions, just use the wallet keypair
                signers = [wallet.keypair];
            }
            
            deserializedTx.sign(signers);
            console.log(`  ${txLabel} signed. Payer: ${deserializedTx.message.payerKey.toBase58()}, Signatures: ${deserializedTx.signatures.filter(s => s && !s.every(b => b === 0)).length} (valid) of ${signers.length} expected.`);
            
            if (!deserializedTx.signatures[0] || deserializedTx.signatures[0].every(byte => byte === 0)) {
                throw new Error(`Signing ${txLabel} failed or produced an empty primary signature.`);
            }
            
            // Additional signature validation for create transactions
            if (signers.length > 1) {
                if (!deserializedTx.signatures[1] || deserializedTx.signatures[1].every(byte => byte === 0)) {
                    throw new Error(`${txLabel}: Expected ${signers.length} signatures, but secondary signature (mintKeypair) is missing or invalid.`);
                }
            }

            // MONOCODE Fix: Capture primary signature before serialization for WebSocket confirmation
            const primarySignature = bs58Decoder.encode(deserializedTx.signatures[0]);
            primarySignatures.push(primarySignature);

            signedEncodedTransactions.push(bs58Decoder.encode(deserializedTx.serialize()));
            console.log(`  ${txLabel} prepared for Jito bundle. Primary signature: ${primarySignature.slice(0, 8)}...`);

        } catch (error) {
            console.error(`  Error processing ${txLabel}:`, error.message);
            if (error.stack) console.error(error.stack);
            throw error; // Propagate error to stop batch processing
        }
    }
    return { signedEncodedTransactions, primarySignatures };
}


module.exports = {
    uploadMetadataToPumpPortal,
    getTransactionsFromPumpPortal,
    preparePumpTransactionsForJito,
    PUMP_PORTAL_API_URL,
    PUMP_PORTAL_TRADE_LOCAL_ENDPOINT,
    DEFAULT_JITO_TIP_VIA_PUMP_PORTAL_PRIORITY_FEE,
    DEFAULT_PUMP_PORTAL_NOMINAL_SUBSEQUENT_TX_FEE_SOL
}; 
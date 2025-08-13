const fs = require('fs').promises;
const path = require('path');
const web3 = require('@solana/web3.js');
const bs58 = require('bs58');
const { getAssociatedTokenAddress } = require('@solana/spl-token'); // MONOCODE: Add for getTokenBalance

// Configuration for wallet storage - API services will use this.
// For now, defaults to a 'data/wallets' directory in the project root.
const PROJECT_ROOT_DATA_DIR = path.join(__dirname, '..', '..', 'data'); // Assuming utils is in src/utils
const WALLETS_DATA_SUBDIR = 'wallets';
const WALLETS_DIR = path.join(PROJECT_ROOT_DATA_DIR, WALLETS_DATA_SUBDIR);

/**
 * Ensures the data and wallets directory exists.
 */
async function ensureWalletsDirectoryExists() {
    try {
        // Check/create project root data directory first
        try {
            await fs.access(PROJECT_ROOT_DATA_DIR);
        } catch (error) {
            if (error.code === 'ENOENT') {
                await fs.mkdir(PROJECT_ROOT_DATA_DIR, { recursive: true });
                console.log(`Project data directory created: ${PROJECT_ROOT_DATA_DIR}`);
            } else {
                throw error;
            }
        }

        // Then check/create wallets subdirectory
        await fs.access(WALLETS_DIR);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.mkdir(WALLETS_DIR, { recursive: true });
            console.log(`Wallets data subdirectory created: ${WALLETS_DIR}`);
        } else {
            throw error;
        }
    }
}

/**
 * Saves a keypair (public key and private key) to a JSON file.
 * @param {web3.Keypair} keypair The keypair to save.
 * @param {string} fileName The name of the file (e.g., 'motherWallet.json').
 * @param {string} [walletName] Optional name for the wallet in the file.
 * @returns {Promise<object>} The wallet data that was saved (including private key).
 */
async function saveKeypairToFile(keypair, fileName, walletName) {
    await ensureWalletsDirectoryExists();
    const filePath = path.join(WALLETS_DIR, fileName);
    const walletData = {
        publicKey: keypair.publicKey.toBase58(),
        privateKey: Buffer.from(keypair.secretKey).toString('base64'), // Store as base64
    };
    if (walletName) {
        walletData.name = walletName;
    }
    await fs.writeFile(filePath, JSON.stringify(walletData, null, 2));
    console.log(`Wallet "${walletName || keypair.publicKey.toBase58()}" saved to ${filePath}`);
    return walletData; // Return the data, including private key, for API response
}

/**
 * Loads a keypair from a JSON file.
 * @param {string} fileName The name of the file (e.g., 'motherWallet.json').
 * @returns {Promise<{name?: string, publicKey: string, keypair: web3.Keypair} | null>}
 * The loaded keypair object including name and public key, or null if file not found.
 */
async function loadKeypairFromFile(fileName) {
    const filePath = path.join(WALLETS_DIR, fileName);
    try {
        await fs.access(filePath);
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const walletData = JSON.parse(fileContent);
        if (!walletData.privateKey) {
            throw new Error(`Private key not found in wallet file: ${fileName}`);
        }
        
        let secretKey;
        // Assuming all stored private keys are base64 encoded as per saveKeypairToFile and saveChildWalletsToFile
        try {
            secretKey = Buffer.from(walletData.privateKey, 'base64');
        } catch (e) {
            console.error(`Error decoding base64 private key from ${fileName}: ${e.message}`);
            throw new Error(`Could not decode base64 private key from wallet file: ${fileName}.`);
        }
        
        if (secretKey.length !== 64) {
            throw new Error(`Decoded private key from ${fileName} has invalid length: ${secretKey.length}, expected 64.`);
        }

        const keypair = web3.Keypair.fromSecretKey(new Uint8Array(secretKey));
        
        // Consistency check: loaded keypair's public key should match stored public key
        if (walletData.publicKey && keypair.publicKey.toBase58() !== walletData.publicKey) {
            console.warn(`Warning: Public key mismatch for ${fileName}. Stored: ${walletData.publicKey}, Derived: ${keypair.publicKey.toBase58()}. Using derived key.`);
        }

        return {
            name: walletData.name, // Will be undefined if not present, which is fine
            publicKey: keypair.publicKey.toBase58(), // Return derived public key for certainty
            keypair: keypair
        };

    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        console.error(`Error loading keypair from ${filePath}:`, error);
        throw error; 
    }
}

/**
 * Loads multiple keypairs from a JSON file (expected to be an array of wallet data).
 * @param {string} fileName The name of the file (e.g., 'childWallets.json').
 * @returns {Promise<Array<{name: string, publicKey: string, keypair: web3.Keypair}>>} An array of named keypairs.
 */
async function loadChildWalletsFromFile(fileName) {
    const filePath = path.join(WALLETS_DIR, fileName);
    try {
        await fs.access(filePath);
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const walletsArray = JSON.parse(fileContent);
        if (!Array.isArray(walletsArray)) {
            throw new Error(`Child wallets file ${fileName} does not contain an array.`);
        }
        
        return walletsArray.map(walletData => {
            if (!walletData.privateKey || !walletData.name || !walletData.publicKey) {
                throw new Error(`Invalid child wallet entry in ${fileName}: missing privateKey, name, or publicKey. Entry: ${JSON.stringify(walletData)}`);
            }
            
            let secretKey;
            try {
                secretKey = Buffer.from(walletData.privateKey, 'base64');
            } catch (e) {
                console.error(`Error decoding base64 private key for wallet ${walletData.name} in ${fileName}: ${e.message}`);
                throw new Error(`Could not decode base64 private key for wallet: ${walletData.name} in ${fileName}.`);
            }

            if (secretKey.length !== 64) {
                console.error(`Decoded key for ${walletData.name} in ${fileName} has invalid length: ${secretKey.length}, expected 64`);
                throw new Error(`Decoded private key for wallet ${walletData.name} in ${fileName} has invalid length.`);
            }
            
            const keypair = web3.Keypair.fromSecretKey(new Uint8Array(secretKey));

            if (keypair.publicKey.toBase58() !== walletData.publicKey) {
                console.warn(`Warning: Public key mismatch for child wallet ${walletData.name} in ${fileName}. Stored: ${walletData.publicKey}, Derived: ${keypair.publicKey.toBase58()}. Using derived key.`);
            }

            return {
                name: walletData.name,
                publicKey: keypair.publicKey.toBase58(), // Use derived public key
                keypair: keypair
            };
        });
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        console.error(`Error loading child wallets from ${filePath}:`, error);
        throw error;
    }
}

/**
 * Saves multiple child keypairs to a JSON file.
 * @param {Array<{name: string, keypair: web3.Keypair}>} childWalletsWithNames Array of objects with name and keypair.
 * @param {string} fileName The name of the file (e.g., 'childWallets.json').
 * @returns {Promise<Array<object>>} Array of wallet data that was saved.
 */
async function saveChildWalletsToFile(childWalletsWithNames, fileName) {
    await ensureWalletsDirectoryExists();
    const filePath = path.join(WALLETS_DIR, fileName);
    const walletsData = childWalletsWithNames.map(wallet => ({
        name: wallet.name,
        publicKey: wallet.keypair.publicKey.toBase58(),
        privateKey: Buffer.from(wallet.keypair.secretKey).toString('base64'),
    }));
    await fs.writeFile(filePath, JSON.stringify(walletsData, null, 2));
    console.log(`${walletsData.length} child wallets saved to ${filePath}`);
    return walletsData;
}


/**
 * Gets the SOL balance of a given public key.
 * @param {web3.Connection} connection Solana connection object.
 * @param {web3.PublicKey} publicKey The public key of the wallet.
 * @returns {Promise<number>} The balance in SOL.
 */
async function getWalletBalance(connection, publicKey) {
    try {
        const lamports = await connection.getBalance(publicKey);
        return lamports / web3.LAMPORTS_PER_SOL;
    } catch (error) {
        console.error(`Error getting balance for ${publicKey.toBase58()}:`, error);
        // Do not throw here for API, let service decide how to handle
        return -1; // Indicate error
    }
}

/**
 * Gets the token balance of a given public key for a specific mint.
 * @param {web3.Connection} connection Solana connection object.
 * @param {web3.PublicKey} walletPublicKey The public key of the wallet.
 * @param {web3.PublicKey} mintPublicKey The public key of the token mint.
 * @returns {Promise<number>} The token balance (uiAmount).
 */
async function getTokenBalance(connection, walletPublicKey, mintPublicKey) {
    try {
        const tokenAccount = await getAssociatedTokenAddress(
            mintPublicKey,
            walletPublicKey,
            true // allowOwnerOffCurve - set to true for associated token accounts
        );

        const balance = await connection.getTokenAccountBalance(tokenAccount);
        return balance.value.uiAmount || 0;
    } catch (error) {
        if (error.message.includes('could not find account')) {
            // It's common for a wallet to not have a token account if it has no tokens
            return 0;
        }
        console.error(`Error getting token balance for wallet ${walletPublicKey.toBase58()} and mint ${mintPublicKey.toBase58()}:`, error);
        return 0; // Return 0 on error to prevent transaction failures
    }
}

// Solana connection configuration - this should be configurable for the API
// For now, keeping it simple.
let solanaConnection;
function getSolanaConnection(rpcUrl, commitment = 'confirmed') {
    // Prefer explicit arg, then env var, then mainnet-beta default
    const envRpcUrl = process.env.SOLANA_RPC_URL;
    const effectiveRpcUrl = rpcUrl || envRpcUrl || web3.clusterApiUrl('mainnet-beta');

    // Allow overriding commitment via env while preserving explicit arg precedence
    const effectiveCommitment = commitment || process.env.SOLANA_COMMITMENT || 'confirmed';

    if (!solanaConnection || solanaConnection.rpcEndpoint !== effectiveRpcUrl) {
        console.log(`Initializing Solana connection to: ${effectiveRpcUrl} with commitment: ${effectiveCommitment}`);
        solanaConnection = new web3.Connection(effectiveRpcUrl, effectiveCommitment);
    }
    return solanaConnection;
}

module.exports = {
    saveKeypairToFile,
    loadKeypairFromFile,
    loadChildWalletsFromFile,
    saveChildWalletsToFile,
    getWalletBalance,
    getTokenBalance, // MONOCODE: Export getTokenBalance for SPL token balance validation
    ensureWalletsDirectoryExists,
    getSolanaConnection,
    WALLETS_DIR,
    PROJECT_ROOT_DATA_DIR
}; 
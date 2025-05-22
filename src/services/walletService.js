const web3 = require('@solana/web3.js');
const bs58 = require('bs58');
const { saveKeypairToFile, loadKeypairFromFile, loadChildWalletsFromFile, saveChildWalletsToFile, getWalletBalance, getSolanaConnection, WALLETS_DIR } = require('../utils/walletUtils');
const { sendAndConfirmTransactionRobustly, sleep } = require('../utils/transactionUtils');

const MOTHER_WALLET_FILE = 'motherWallet.json';
const CHILD_WALLETS_FILE = 'childWallets.json';
const SOL_TO_LEAVE_FOR_FEES = 0.00002; // Small amount of SOL to leave in child wallets for future tx fees if any

/**
 * Creates a new Airdrop (Mother) wallet or imports an existing one.
 * @param {string} [privateKeyBs58] - Optional base58 private key to import.
 * @returns {Promise<object>} Wallet details { publicKey, privateKey, name }.
 */
async function createOrImportMotherWalletService(privateKeyBs58) {
    let keypair;
    const walletName = "MotherAirdropWallet";
    if (privateKeyBs58) {
        try {
            const secretKey = bs58.decode(privateKeyBs58);
            if (secretKey.length !== 64) {
                throw new Error('Invalid private key length. Must be 64 bytes for a Solana keypair.');
            }
            keypair = web3.Keypair.fromSecretKey(secretKey);
            console.log(`Mother wallet imported: ${keypair.publicKey.toBase58()}`);
        } catch (error) {
            console.error('Failed to import mother wallet from private key:', error.message);
            throw new Error(`Invalid private key provided for import: ${error.message}`);
        }
    } else {
        keypair = web3.Keypair.generate();
        console.log(`New mother wallet created: ${keypair.publicKey.toBase58()}`);
    }

    // Save and return, including the private key as per user requirement for API response
    const savedWalletData = await saveKeypairToFile(keypair, MOTHER_WALLET_FILE, walletName);
    return savedWalletData; 
}


// --- Placeholder for other wallet services ---

/**
 * Creates a specified number of new Bundled (Child) Wallets.
 * One will be named DevWallet, first four after DevWallet will be "First Bundled Wallet X".
 * @param {number} count - Total number of child wallets to create (including DevWallet).
 * @param {string} devWalletName - Name for the dev wallet (e.g., "DevWallet").
 * @param {string} firstBundledWalletBaseName - Base name for the first 4 special bundled wallets (e.g., "First Bundled Wallet").
 * @returns {Promise<Array<object>>} Array of created wallet details [{ name, publicKey, privateKey }].
 */
async function createBundledWalletsService(count, devWalletName = "DevWallet", firstBundledWalletBaseName = "First Bundled Wallet") {
    if (count < 1) throw new Error('Must create at least one child wallet (for DevWallet).');
    
    const childWallets = [];
    for (let i = 0; i < count; i++) {
        const keypair = web3.Keypair.generate();
        let name;
        if (i === 0) {
            name = devWalletName;
        } else if (i >= 1 && i <= 4) {
            name = `${firstBundledWalletBaseName} ${i}`;
        } else {
            const genericIndex = i - (count > 4 ? 4 : 0); // Adjust index for generic naming
            name = `ChildWallet${genericIndex}`;
        }
        childWallets.push({ name, keypair });
    }
    console.log(`${count} child wallets generated programmatically.`);
    const savedWalletsData = await saveChildWalletsToFile(childWallets, CHILD_WALLETS_FILE);
    return savedWalletsData;
}

/**
 * Imports Bundled (Child) Wallets from an array of private keys.
 * @param {Array<{name: string, privateKeyBs58: string}>} walletImportData - Array of objects with name and privateKeyBs58.
 * @returns {Promise<Array<object>>} Array of imported wallet details [{ name, publicKey, privateKey }].
 */
async function importBundledWalletsService(walletImportData) {
    if (!walletImportData || walletImportData.length === 0) {
        throw new Error('No wallet data provided for import.');
    }

    const childWallets = [];
    for (const { name, privateKeyBs58 } of walletImportData) {
        if (!name || !privateKeyBs58) {
            throw new Error('Each wallet import entry must have a name and a privateKeyBs58.');
        }
        try {
            const secretKey = bs58.decode(privateKeyBs58);
            if (secretKey.length !== 64) {
                throw new Error(`Invalid private key length for wallet ${name}. Must be 64 bytes.`);
            }
            const keypair = web3.Keypair.fromSecretKey(secretKey);
            childWallets.push({ name, keypair });
        } catch (error) {
            throw new Error(`Failed to import wallet ${name}: ${error.message}`);
        }
    }
    console.log(`${childWallets.length} child wallets imported programmatically.`);
    const savedWalletsData = await saveChildWalletsToFile(childWallets, CHILD_WALLETS_FILE);
    return savedWalletsData;
}

async function getWalletBalanceService(publicKeyString) {
    try {
        const publicKey = new web3.PublicKey(publicKeyString);
        const connection = getSolanaConnection();
        const balance = await getWalletBalance(connection, publicKey);
        if (balance === -1) throw new Error('Failed to retrieve balance.');
        return { publicKey: publicKeyString, balance };
    } catch (error) {
        console.error(`Error in getWalletBalanceService for ${publicKeyString}:`, error.message);
        throw new Error(`Invalid public key or failed to retrieve balance: ${error.message}`);
    }
}

/**
 * Funds specified child wallets from the mother wallet.
 * @param {number} amountPerWalletSOL - Amount of SOL to send to each child wallet.
 * @param {string[]} [targetWalletNames] - Optional array of child wallet names to fund. If empty/null, funds all.
 * @param {string} [motherWalletPrivateKeyBs58] - Optional private key for mother wallet if not using default.
 * @returns {Promise<Array<object>>} Array of results, each { name, publicKey, signature, status, balanceAfter }.
 */
async function fundChildWalletsService(amountPerWalletSOL, targetWalletNames, motherWalletPrivateKeyBs58) {
    const connection = getSolanaConnection();
    let motherWallet;
    if (motherWalletPrivateKeyBs58) {
        try {
            const secretKey = bs58.decode(motherWalletPrivateKeyBs58);
            motherWallet = web3.Keypair.fromSecretKey(secretKey);
        } catch (e) {
            throw new Error('Invalid mother wallet private key for funding.');
        }
    } else {
        const loadedMother = await loadKeypairFromFile(MOTHER_WALLET_FILE);
        if (!loadedMother) throw new Error('Mother wallet not found. Please create or import it first.');
        motherWallet = loadedMother.keypair;
    }

    const motherBalance = await getWalletBalance(connection, motherWallet.publicKey);
    console.log(`Mother wallet ${motherWallet.publicKey.toBase58()} balance: ${motherBalance} SOL`);

    let allChildWallets = await loadChildWalletsFromFile(CHILD_WALLETS_FILE);
    if (!allChildWallets || allChildWallets.length === 0) {
        throw new Error('No child wallets found. Please create them first.');
    }

    const walletsToFund = targetWalletNames && targetWalletNames.length > 0
        ? allChildWallets.filter(cw => targetWalletNames.includes(cw.name))
        : allChildWallets;

    if (walletsToFund.length === 0) {
        throw new Error('No matching child wallets to fund based on provided names.');
    }

    const lamportsToSend = amountPerWalletSOL * web3.LAMPORTS_PER_SOL;
    const totalSOLNeeded = amountPerWalletSOL * walletsToFund.length + (0.000005 * walletsToFund.length); // Rough fee estimate
    if (motherBalance < totalSOLNeeded) {
        throw new Error(`Insufficient SOL in mother wallet. Needs ~${totalSOLNeeded.toFixed(6)}, has ${motherBalance.toFixed(6)}.`);
    }

    const results = [];
    for (const child of walletsToFund) {
        console.log(`Funding ${child.name} (${child.publicKey}) with ${amountPerWalletSOL} SOL...`);
        const transaction = new web3.Transaction().add(
            web3.SystemProgram.transfer({
                fromPubkey: motherWallet.publicKey,
                toPubkey: new web3.PublicKey(child.publicKey),
                lamports: lamportsToSend,
            })
        );
        try {
            const signature = await sendAndConfirmTransactionRobustly(connection, transaction, [motherWallet], { skipPreflight: true });
            const balanceAfter = await getWalletBalance(connection, new web3.PublicKey(child.publicKey));
            results.push({ 
                name: child.name, 
                publicKey: child.publicKey, 
                signature, 
                status: 'success', 
                amountSent: amountPerWalletSOL,
                balanceAfter 
            });
            console.log(`Successfully funded ${child.name}. New balance: ${balanceAfter} SOL. Tx: ${signature}`);
            if (walletsToFund.indexOf(child) < walletsToFund.length - 1) await sleep(1000); // Short delay between txs
        } catch (error) {
            console.error(`Failed to fund ${child.name}: ${error.message}`);
            results.push({ name: child.name, publicKey: child.publicKey, status: 'failed', error: error.message, amountSent: amountPerWalletSOL });
        }
    }
    return results;
}

/**
 * Returns SOL from specified child wallets to the mother wallet.
 * @param {string} motherWalletPublicKeyBs58 - Public key of the mother wallet to receive funds.
 * @param {string[]} [sourceWalletNames] - Optional array of child wallet names to return funds from. If empty/null, returns from all.
 * @returns {Promise<Array<object>>} Array of results, each { name, publicKey, signature, status, balanceAfter, amountReturned }.
 */
async function returnFundsToMotherWalletService(motherWalletPublicKeyBs58, sourceWalletNames) {
    const connection = getSolanaConnection();
    const motherPublicKey = new web3.PublicKey(motherWalletPublicKeyBs58);

    let allChildWallets = await loadChildWalletsFromFile(CHILD_WALLETS_FILE);
    if (!allChildWallets || allChildWallets.length === 0) {
        throw new Error('No child wallets found to return funds from.');
    }

    const walletsToReturnFrom = sourceWalletNames && sourceWalletNames.length > 0
        ? allChildWallets.filter(cw => sourceWalletNames.includes(cw.name))
        : allChildWallets;

    if (walletsToReturnFrom.length === 0) {
        throw new Error('No matching child wallets to return funds from based on provided names.');
    }

    const results = [];
    for (const child of walletsToReturnFrom) {
        const childKeypair = child.keypair;
        const childPublicKey = new web3.PublicKey(child.publicKey);
        let amountToReturnLamports = 0;
        let status = 'failed';
        let signature = null;
        let errorMsg = null;
        let balanceBefore = 0;

        try {
            balanceBefore = await getWalletBalance(connection, childPublicKey);
            if (balanceBefore <= SOL_TO_LEAVE_FOR_FEES) {
                console.log(`${child.name} (${child.publicKey}) has insufficient balance (${balanceBefore} SOL) to return funds. Skipping.`);
                results.push({ name: child.name, publicKey: child.publicKey, status: 'skipped_low_balance', amountReturned: 0, balanceAfter: balanceBefore });
                continue;
            }
            amountToReturnLamports = Math.floor((balanceBefore - SOL_TO_LEAVE_FOR_FEES) * web3.LAMPORTS_PER_SOL);
            
            if (amountToReturnLamports <= 0) {
                 console.log(`${child.name} (${child.publicKey}) balance after leaving fees is too low (${amountToReturnLamports} lamports). Skipping.`);
                 results.push({ name: child.name, publicKey: child.publicKey, status: 'skipped_low_after_fees', amountReturned: 0, balanceAfter: balanceBefore });
                 continue;
            }

            console.log(`Returning ${amountToReturnLamports / web3.LAMPORTS_PER_SOL} SOL from ${child.name} (${child.publicKey}) to ${motherPublicKey.toBase58()}...`);
            const transaction = new web3.Transaction().add(
                web3.SystemProgram.transfer({
                    fromPubkey: childPublicKey,
                    toPubkey: motherPublicKey,
                    lamports: amountToReturnLamports,
                })
            );
            signature = await sendAndConfirmTransactionRobustly(connection, transaction, [childKeypair], { skipPreflight: true });
            status = 'success';
            console.log(`Successfully returned SOL from ${child.name}. Tx: ${signature}`);
        } catch (error) {
            console.error(`Failed to return funds from ${child.name}: ${error.message}`);
            errorMsg = error.message;
        }
        const balanceAfter = await getWalletBalance(connection, childPublicKey);
        results.push({
            name: child.name,
            publicKey: child.publicKey,
            signature,
            status,
            error: errorMsg,
            amountReturned: status === 'success' ? amountToReturnLamports / web3.LAMPORTS_PER_SOL : 0,
            balanceBefore,
            balanceAfter
        });
        if (walletsToReturnFrom.indexOf(child) < walletsToReturnFrom.length - 1) await sleep(1000); // Short delay
    }
    return results;
}


module.exports = {
    createOrImportMotherWalletService,
    createBundledWalletsService,
    importBundledWalletsService,
    getWalletBalanceService,
    fundChildWalletsService,
    returnFundsToMotherWalletService,
    // ... other services to be added
}; 
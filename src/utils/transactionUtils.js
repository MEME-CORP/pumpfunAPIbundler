const web3 = require('@solana/web3.js');
const fetch = require('node-fetch'); // For Jito interactions
const bs58 = require('bs58');
const { getSolanaConnection } = require('./walletUtils'); // Assuming same directory for now or updated path

// Constants for Jito interactions (can be made configurable)
const MAX_RETRIES_JITO_SEND = 7;
const INITIAL_RETRY_DELAY_JITO_SEND = 2000;
const MAX_RETRY_DELAY_JITO_SEND = 30000;
const BUNDLE_STATUS_POLL_INTERVAL = 2000;
const BUNDLE_STATUS_POLL_ATTEMPTS = 10; // Default, can be overridden
const JITO_REGIONAL_ENDPOINT = 'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles'; // Default, can be overridden

/**
 * Sleeps for a specified number of milliseconds.
 * @param {number} ms - The number of milliseconds to sleep.
 * @returns {Promise<void>} A promise that resolves after the sleep duration.
 */
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sends a standard Solana transaction with retries and robust confirmation.
 * (To be implemented based on TXLANDING.MD principles - simplified for now)
 * - Dynamic priority fees
 * - Effective blockhash management
 * - Robust retry logic (resend signed tx, re-sign with new blockhash if expired)
 * - Skip preflight simulation as requested
 * @param {web3.Connection} connection - Solana connection object.
 * @param {web3.Transaction | web3.VersionedTransaction} transaction - The transaction to send.
 * @param {web3.Signer[]} signers - Array of signers for the transaction.
 * @param {object} [options] - Optional parameters.
 * @param {boolean} [options.skipPreflight=true] - Whether to skip preflight simulation.
 * @param {number} [options.maxRetries=5] - Maximum retries for sending/confirming.
 * @param {web3.Commitment} [options.commitment='confirmed'] - Desired commitment level.
 * @returns {Promise<string>} The transaction signature.
 */
async function sendAndConfirmTransactionRobustly(connection, transaction, signers, options = {}) {
    const { skipPreflight = true, maxRetries = 5, commitment = 'confirmed' } = options;
    let latestBlockhash = await connection.getLatestBlockhash(commitment);

    if (transaction instanceof web3.Transaction) {
        transaction.recentBlockhash = latestBlockhash.blockhash;
        transaction.feePayer = signers[0].publicKey; // Assuming first signer is fee payer
        // Sign with all signers
        // transaction.sign(...signers); // web3.js handles this with sendTransaction
    } else if (transaction instanceof web3.VersionedTransaction) {
        // For VersionedTransaction, signing is usually done before this function call.
        // Blockhash should also be set before, but we can refresh it if needed.
        transaction.message.recentBlockhash = latestBlockhash.blockhash;
    }

    let retries = 0;
    while (retries < maxRetries) {
        try {
            console.log(`Attempt ${retries + 1}/${maxRetries}: Sending transaction...`);
            const signature = await web3.sendAndConfirmTransaction(
                connection,
                transaction,
                signers, 
                {
                    skipPreflight: skipPreflight,
                    commitment: commitment,
                    preflightCommitment: commitment, // For simulation if not skipped
                    maxRetries: 0 // We handle retries externally for blockhash refresh
                }
            );
            console.log(`Transaction confirmed with signature: ${signature}`);
            console.log(`  Solscan: https://solscan.io/tx/${signature}?cluster=mainnet-beta`);
            return signature;
        } catch (error) {
            console.warn(`Attempt ${retries + 1} failed: ${error.message}`);
            retries++;
            if (retries >= maxRetries) {
                console.error('Max retries reached. Transaction failed.');
                throw error;
            }

            // Refresh blockhash for next attempt
            console.log('Refreshing blockhash...');
            latestBlockhash = await connection.getLatestBlockhash(commitment);
            if (transaction instanceof web3.Transaction) {
                transaction.recentBlockhash = latestBlockhash.blockhash;
            } else if (transaction instanceof web3.VersionedTransaction) {
                transaction.message.recentBlockhash = latestBlockhash.blockhash;
                 // Re-signing VersionedTransaction if blockhash changes is tricky as original signers are needed.
                 // Best to ensure VersionedTransactions are passed here already signed with a recent enough blockhash,
                 // or the retry logic here should be simpler (just resend, fail if blockhash expires soon).
                 // For now, we assume Jito bundles manage this more actively with their specific send function.
            }
            await sleep(2000 * (retries + 1)); // Exponential backoff basic
        }
    }
    throw new Error('Failed to send and confirm transaction after multiple retries.');
}


/**
 * Sends a bundle of transactions to the Jito Block Engine with retries.
 * @param {string[]} encodedSignedTxs_base58 - Array of base58 encoded signed transactions.
 * @param {object} [jitoOptions] - Options for Jito interaction.
 * @param {string} [jitoOptions.jitoEndpoint] - Jito regional endpoint.
 * @param {number} [jitoOptions.maxRetries] - Max retries for sending.
 * @param {number} [jitoOptions.initialDelay] - Initial retry delay.
 * @param {number} [jitoOptions.maxDelay] - Max retry delay.
 * @returns {Promise<string>} The bundle ID.
 */
async function sendJitoBundleWithRetries(encodedSignedTxs_base58, jitoOptions = {}) {
    const endpoint = jitoOptions.jitoEndpoint || JITO_REGIONAL_ENDPOINT;
    const maxRetries = jitoOptions.maxRetries || MAX_RETRIES_JITO_SEND;
    let currentDelay = jitoOptions.initialDelay || INITIAL_RETRY_DELAY_JITO_SEND;
    const maxDelay = jitoOptions.maxDelay || MAX_RETRY_DELAY_JITO_SEND;

    let retryCount = 0;
    while (retryCount < maxRetries) {
        try {
            console.log(`  Attempting to send Jito bundle (attempt ${retryCount + 1}/${maxRetries}) to ${endpoint}...`);
            const jitoRpcParams = [encodedSignedTxs_base58];
            const requestBody = { jsonrpc: '2.0', id: 1, method: 'sendBundle', params: jitoRpcParams };

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            if (response.ok) {
                const data = await response.json();
                if (data.error) {
                    throw new Error(`Jito sendBundle RPC error: ${data.error.message} (Code: ${data.error.code || 'N/A'})`);
                }
                if (!data.result) {
                    let detail = "";
                    try { detail = JSON.stringify(data); } catch (e) { detail = String(data); }
                    throw new Error('Jito sendBundle response missing result (bundleId). Response: ' + detail);
                }
                return data.result; // Bundle ID
            }

            const errorText = await response.text();
            if (response.status === 429) { // Rate limited
                const retryAfterHeader = response.headers.get('Retry-After');
                const waitTime = retryAfterHeader ? parseInt(retryAfterHeader) * 1000 : currentDelay;
                console.warn(`  Rate limited by Jito sendBundle. Waiting ${waitTime/1000} seconds...`);
                await sleep(waitTime);
                currentDelay = Math.min(currentDelay * 2, maxDelay);
            } else {
                throw new Error(`  Failed to send Jito bundle: HTTP ${response.status}. Response: ${errorText}`);
            }
        } catch (error) {
            console.warn(`  Error in sendJitoBundleWithRetries (attempt ${retryCount + 1}): ${error.message}`);
            if (retryCount >= maxRetries - 1) throw error; // Last attempt failed
            await sleep(currentDelay);
            currentDelay = Math.min(currentDelay * 2, maxDelay); // Increase delay for next retry
        }
        retryCount++;
    }
    throw new Error(`  Failed to send Jito bundle to ${endpoint} after ${maxRetries} attempts.`);
}

/**
 * Polls Jito for the status of a bundle.
 * @param {string} bundleId - The ID of the bundle to poll.
 * @param {object} [jitoOptions] - Options for Jito interaction.
 * @param {string} [jitoOptions.jitoEndpoint] - Jito regional endpoint.
 * @param {number} [jitoOptions.pollAttempts] - Number of polling attempts.
 * @param {number} [jitoOptions.pollInterval] - Interval between polls in ms.
 * @returns {Promise<'landed' | 'failed_or_dropped' | 'indeterminate'>} The status of the bundle.
 */
async function pollBundleStatus(bundleId, jitoOptions = {}) {
    const endpoint = jitoOptions.jitoEndpoint || JITO_REGIONAL_ENDPOINT;
    const pollAttempts = jitoOptions.pollAttempts || BUNDLE_STATUS_POLL_ATTEMPTS;
    const pollInterval = jitoOptions.pollInterval || BUNDLE_STATUS_POLL_INTERVAL;

    console.log(`  Polling Jito for bundle status of ${bundleId} (up to ${pollAttempts} attempts, interval ${pollInterval}ms) at ${endpoint}...`);
    for (let attempts = 0; attempts < pollAttempts; attempts++) {
        await sleep(pollInterval);
        if (attempts === 0 || (attempts + 1) % 5 === 0 || attempts === pollAttempts -1 ) {
             console.log(`  Polling attempt ${attempts + 1}/${pollAttempts} for bundle ${bundleId}...`);
        }
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBundleStatuses', params: [[bundleId]] })
            });

            if (response.ok) {
                const data = await response.json();
                if (data.error) {
                    console.warn(`  Jito getBundleStatuses RPC error for ${bundleId}: ${data.error.message}`);
                    continue; // Try next attempt
                }
                if (data.result && data.result.value && data.result.value.length > 0) {
                    const statusInfo = data.result.value[0];
                    console.log(`  Bundle ${bundleId} Jito confirmation_status: ${statusInfo.confirmation_status}, Error: ${JSON.stringify(statusInfo.err)}`);
                    
                    // Check for explicit error in the bundle transaction itself, even if Jito processed it
                    if (statusInfo.err && (typeof statusInfo.err === 'string' && statusInfo.err.toLowerCase() !== 'ok' && statusInfo.err !== null) || 
                        (typeof statusInfo.err === 'object' && statusInfo.err !== null && !statusInfo.err.hasOwnProperty('Ok'))) {
                        console.error(`  Bundle ${bundleId} processed by Jito but with an error state:`, statusInfo.err);
                        return 'failed_or_dropped';
                    }

                    // Check confirmation status
                    const confirmationStatus = statusInfo.confirmation_status ? statusInfo.confirmation_status.toLowerCase() : null;
                    if (confirmationStatus === 'processed' || confirmationStatus === 'confirmed' || confirmationStatus === 'finalized') {
                        return 'landed';
                    } else if (confirmationStatus === 'failed' || confirmationStatus === 'dropped') {
                        console.error(`  Bundle ${bundleId} explicitly failed or was dropped by Jito. Error:`, statusInfo.err);
                        return 'failed_or_dropped';
                    }
                }
            } else {
                const errorText = await response.text();
                console.warn(`  Jito getBundleStatuses HTTP error for ${bundleId} (attempt ${attempts + 1}): ${response.status} ${errorText}`);
            }
        } catch (error) {
            console.warn(`  Error polling Jito bundle status for ${bundleId} (attempt ${attempts + 1}): ${error.message}`);
        }
    }
    console.warn(`  Bundle ${bundleId} status indeterminate after ${pollAttempts} attempts.`);
    return 'indeterminate';
}

/**
 * Gets a recent blockhash from the connection with correct commitment level.
 * Implements best practices from TXLANDING.MD.
 * @param {web3.Connection} connection - Solana connection object.
 * @param {web3.Commitment} [commitment='confirmed'] - Commitment level.
 * @returns {Promise<{blockhash: string, lastValidBlockHeight: number}>} The blockhash info.
 */
async function getRecentBlockhash(connection, commitment = 'confirmed') {
    try {
        console.log(`Getting recent blockhash with ${commitment} commitment...`);
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
        console.log(`Got blockhash: ${blockhash}, last valid block height: ${lastValidBlockHeight}`);
        return { blockhash, lastValidBlockHeight };
    } catch (error) {
        console.error('Error getting recent blockhash:', error);
        throw error;
    }
}

module.exports = {
    sleep,
    sendAndConfirmTransactionRobustly,
    sendJitoBundleWithRetries,
    pollBundleStatus,
    getRecentBlockhash,
    // Make constants available for configuration if needed by services
    MAX_RETRIES_JITO_SEND,
    INITIAL_RETRY_DELAY_JITO_SEND,
    MAX_RETRY_DELAY_JITO_SEND,
    BUNDLE_STATUS_POLL_INTERVAL,
    BUNDLE_STATUS_POLL_ATTEMPTS,
    JITO_REGIONAL_ENDPOINT
}; 
const web3 = require('@solana/web3.js');
const fetch = require('node-fetch'); // For Jito interactions
const bs58 = require('bs58');
const { getSolanaConnection } = require('./walletUtils');

/**
 * RPC Provider Configuration for optimal settings
 * These settings are optimized for each provider type
 */
const RPC_CONFIGS = {
    // Public mainnet-beta (free tier) - VERY strict rate limiting required
    // Official limits: 100 req/10s total, 40 req/10s per method, 40 concurrent connections
    PUBLIC: {
        name: 'Public Mainnet-Beta',
        rpcCallInterval: 1000, // 1000ms between calls (conservative for 100 req/10s = max 10 req/s)
        maxConcurrentRequests: 2, // Very low concurrent requests (limit is 40)
        retryBackoff: 15000, // 15s backoff for 429 errors (much longer)
        confirmationTimeout: 60000, // 60s confirmation timeout (longer for rate-limited environment)
        useWebSocket: true, // Always use WebSocket to avoid polling
        description: 'Free public RPC with VERY strict rate limits - 100 req/10s total'
    },
    
    // Premium providers (QuickNode, Helius, Alchemy) - relaxed settings
    PREMIUM: {
        name: 'Premium RPC Provider',
        rpcCallInterval: 100, // 100ms between calls (higher limits)
        maxConcurrentRequests: 10, // More concurrent requests allowed
        retryBackoff: 1000, // 1s backoff
        confirmationTimeout: 30000, // 30s confirmation timeout
        useWebSocket: true, // WebSocket preferred but polling fallback available
        description: 'Premium RPC with higher rate limits and better performance'
    }
};

// Detect RPC type based on URL
function getRpcConfig() {
    const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    
    if (rpcUrl.includes('api.mainnet-beta.solana.com')) {
        console.log(`[TransactionUtils] Using PUBLIC RPC configuration for: ${rpcUrl}`);
        return RPC_CONFIGS.PUBLIC;
    } else {
        console.log(`[TransactionUtils] Using PREMIUM RPC configuration for: ${rpcUrl}`);
        return RPC_CONFIGS.PREMIUM;
    }
}

const currentRpcConfig = getRpcConfig();

/**
 * Enhanced RPC rate limiting protection based on provider type
 */
let lastRpcCall = 0;
let concurrentRequests = 0;

async function rateLimitedRpcCall(rpcFunction, retries = 3) {
    // Wait for concurrent request slot
    while (concurrentRequests >= currentRpcConfig.maxConcurrentRequests) {
        await sleep(50); // Short wait for slot to open
    }
    
    concurrentRequests++;
    
    try {
        for (let i = 0; i < retries; i++) {
            try {
                // Ensure minimum interval between RPC calls
                const now = Date.now();
                const timeSinceLastCall = now - lastRpcCall;
                if (timeSinceLastCall < currentRpcConfig.rpcCallInterval) {
                    await sleep(currentRpcConfig.rpcCallInterval - timeSinceLastCall);
                }
                lastRpcCall = Date.now();
                
                return await rpcFunction();
            } catch (error) {
                if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
                    const backoffTime = Math.min(currentRpcConfig.retryBackoff * Math.pow(2, i), 30000);
                    console.warn(`[TransactionUtils] RPC rate limited, waiting ${backoffTime}ms (attempt ${i + 1}/${retries})`);
                    await sleep(backoffTime);
                    continue;
                }
                throw error;
            }
        }
        throw new Error('RPC call failed after rate limiting retries');
    } finally {
        concurrentRequests--;
    }
}

/**
 * Gets recent blockhash with proper commitment level and rate limiting protection
 * @param {web3.Connection} connection - Solana connection object
 * @param {web3.Commitment} [commitment='confirmed'] - Commitment level
 * @returns {Promise<{blockhash: string, lastValidBlockHeight: number}>}
 */
async function getRecentBlockhash(connection, commitment = 'confirmed') {
    console.log(`[TransactionUtils] Fetching recent blockhash with commitment: ${commitment}`);
    
    const result = await rateLimitedRpcCall(async () => {
        return await connection.getLatestBlockhash(commitment);
    });
    
    console.log(`[TransactionUtils] Blockhash obtained: ${result.blockhash.slice(0, 8)}...`);
    return result;
}

/**
 * Sleep utility function
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Adds priority fee instructions to a transaction.
 * @param {web3.Transaction} transaction - The transaction to add priority fees to.
 * @param {number} [priorityFeeMicrolamports=100000] - Priority fee in microlamports.
 * @param {number} [computeUnitLimit=200000] - Compute unit limit.
 * @returns {web3.Transaction} The transaction with priority fee instructions added.
 */
function addPriorityFeeInstructions(transaction, priorityFeeMicrolamports = 100000, computeUnitLimit = 200000) {
    console.log(`[TransactionUtils] Adding priority fee: ${priorityFeeMicrolamports} microlamports, CU limit: ${computeUnitLimit}`);
    
    // Add compute unit limit instruction
    const computeUnitLimitInstruction = web3.ComputeBudgetProgram.setComputeUnitLimit({
        units: computeUnitLimit
    });
    
    // Add compute unit price instruction (priority fee)
    const computeUnitPriceInstruction = web3.ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: priorityFeeMicrolamports
    });
    
    // Add instructions at the beginning of the transaction
    transaction.instructions.unshift(computeUnitPriceInstruction, computeUnitLimitInstruction);
    
    return transaction;
}

/**
 * ADVANCED WebSocket-based confirmation with polling fallback
 * This is the OPTIMAL strategy based on research to avoid rate limits
 * @param {web3.Connection} connection - Solana connection object
 * @param {string} signature - Transaction signature
 * @param {string} blockhash - Recent blockhash used in transaction
 * @param {number} lastValidBlockHeight - Last valid block height
 * @param {web3.Commitment} commitment - Commitment level
 * @returns {Promise<object>} Confirmation result
 */
async function confirmTransactionAdvanced(connection, signature, blockhash, lastValidBlockHeight, commitment = 'confirmed') {
    console.log(`[TransactionUtils] Starting ADVANCED WebSocket confirmation for: ${signature.slice(0, 8)}...`);

    if (currentRpcConfig.useWebSocket) {
        try {
            return await confirmWithWebSocket(connection, signature, blockhash, lastValidBlockHeight, commitment);
        } catch (error) {
            console.warn(`[TransactionUtils] WebSocket confirmation failed: ${error.message}. This may trigger a retry.`);
            throw error;
        }
    } else {
        console.log(`[TransactionUtils] RPC config directs to use polling confirmation.`);
        return await confirmWithPolling(connection, signature, blockhash, lastValidBlockHeight, commitment);
    }
}

/**
 * WebSocket-based confirmation (optimal for rate limiting)
 */
async function confirmWithWebSocket(connection, signature, blockhash, lastValidBlockHeight, commitment) {
    console.log(`[TransactionUtils] Using WebSocket confirmation strategy`);
    
    return new Promise((resolve, reject) => {
        let subscriptionId = null;
        let timeoutId = null;
        let resolved = false;
        
        const cleanup = () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            if (subscriptionId) {
                const subId = subscriptionId;
                subscriptionId = null;
                connection.removeSignatureListener(subId).catch(() => {});
            }
        };
        
        const handleResult = (result, isTimeout = false) => {
            if (resolved) return;
            resolved = true;
            cleanup();
            
            if (isTimeout) {
                reject(new Error(`WebSocket confirmation timed out after ${currentRpcConfig.confirmationTimeout}ms`));
            } else if (result.err) {
                reject(new Error(`Transaction failed: ${JSON.stringify(result.err)}`));
            } else {
                console.log(`[TransactionUtils] ✅ WebSocket confirmation successful!`);
                resolve({ value: result });
            }
        };
        
        try {
            // Set up WebSocket listener
            subscriptionId = connection.onSignatureWithOptions(
                signature,
                (notificationResult, context) => {
                    console.log(`[TransactionUtils] WebSocket notification received in slot: ${context.slot}`);
                    handleResult(notificationResult);
                },
                { commitment: commitment }
            );
            
            // Set timeout with fallback check
            timeoutId = setTimeout(async () => {
                if (resolved) return;
                
                console.log(`[TransactionUtils] WebSocket timeout reached, doing final status check...`);
                
                try {
                    const statusResult = await rateLimitedRpcCall(async () => {
                        return await connection.getSignatureStatus(signature);
                    });
                    
                    if (statusResult && statusResult.value) {
                        const status = statusResult.value;
                        const isConfirmed = status.confirmationStatus === commitment || 
                                           (commitment === 'confirmed' && status.confirmationStatus === 'finalized');
                        
                        if (isConfirmed && !status.err) {
                            console.log(`[TransactionUtils] ✅ Confirmed by fallback status check!`);
                            handleResult(status);
                            return;
                        }
                    }
                    
                    handleResult(null, true); // Timeout
                } catch (error) {
                    console.warn(`[TransactionUtils] Final status check failed: ${error.message}`);
                    handleResult(null, true); // Timeout
                }
            }, currentRpcConfig.confirmationTimeout);
            
        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}

/**
 * Polling-based confirmation with smart rate limiting
 */
async function confirmWithPolling(connection, signature, blockhash, lastValidBlockHeight, commitment) {
    console.log(`[TransactionUtils] Using polling confirmation strategy`);
    
    try {
        const confirmation = await rateLimitedRpcCall(async () => {
            return await connection.confirmTransaction({
                signature: signature,
                blockhash: blockhash,
                lastValidBlockHeight: lastValidBlockHeight
            }, commitment);
        });
        
        if (confirmation.value.err) {
            throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }
        
        console.log(`[TransactionUtils] ✅ Polling confirmation successful!`);
        return confirmation;
        
    } catch (error) {
        console.error(`[TransactionUtils] ❌ Polling confirmation failed: ${error.message}`);
        throw error;
    }
}

/**
 * Smart confirmation fallback to prevent duplicate transactions
 * This checks if a transaction already succeeded before retrying
 */
async function checkTransactionStatus(connection, signature) {
    try {
        console.log(`[TransactionUtils] Checking existing transaction status for: ${signature.slice(0, 8)}...`);
        
        const status = await rateLimitedRpcCall(async () => {
            return await connection.getSignatureStatus(signature);
        });
        
        if (status && status.value) {
            const result = status.value;
            if (result.confirmationStatus === 'confirmed' || result.confirmationStatus === 'finalized') {
                if (!result.err) {
                    console.log(`[TransactionUtils] ✅ Transaction already confirmed! Status: ${result.confirmationStatus}`);
                    return { confirmed: true, signature };
                } else {
                    console.log(`[TransactionUtils] ❌ Transaction failed with error: ${JSON.stringify(result.err)}`);
                    return { confirmed: false, error: result.err };
                }
            }
        }
        
        return { confirmed: false };
    } catch (error) {
        console.warn(`[TransactionUtils] Could not check transaction status: ${error.message}`);
        return { confirmed: false };
    }
}

/**
 * Calculates accurate transaction fee including priority fees
 * @param {number} priorityFeeMicrolamports - Priority fee in microlamports
 * @param {number} computeUnitLimit - Compute unit limit
 * @returns {number} Estimated total fee in lamports
 */
function calculateTransactionFee(priorityFeeMicrolamports = 100000, computeUnitLimit = 200000) {
    const baseFee = 5000; // Base transaction fee in lamports
    const priorityFeeInLamports = Math.ceil((priorityFeeMicrolamports * computeUnitLimit) / 1000000);
    const totalFee = baseFee + priorityFeeInLamports;
    
    console.log(`[TransactionUtils] Fee calculation: Base=${baseFee}, Priority=${priorityFeeInLamports}, Total=${totalFee} lamports`);
    return totalFee;
}

/**
 * Enhanced transaction sender with ADVANCED confirmation and smart fallback
 * Uses WebSocket-based confirmation with polling fallback to avoid rate limits
 * Includes duplicate transaction prevention based on research findings
 * @param {web3.Connection} connection - Solana connection object.
 * @param {web3.Transaction} transaction - The transaction to send.
 * @param {web3.Signer[]} signers - Array of signers for the transaction.
 * @param {object} [options] - Optional parameters.
 * @param {boolean} [options.skipPreflight=false] - Whether to skip preflight simulation.
 * @param {number} [options.maxRetries=3] - Maximum retries for sending/confirming.
 * @param {web3.Commitment} [options.commitment='confirmed'] - Desired commitment level.
 * @param {number} [options.priorityFeeMicrolamports=100000] - Priority fee in microlamports.
 * @param {number} [options.computeUnitLimit=200000] - Compute unit limit.
 * @returns {Promise<string>} The transaction signature.
 */
async function sendAndConfirmTransactionRobustly(connection, transaction, signers, options = {}) {
    const {
        skipPreflight = false,
        maxRetries = 3,
        commitment = 'confirmed',
        priorityFeeMicrolamports = 100000,
        computeUnitLimit = 200000
    } = options;

    console.log(`[TransactionUtils] Starting ADVANCED transaction strategy with ${maxRetries} max retries`);
    console.log(`[TransactionUtils] RPC Config: ${currentRpcConfig.name} - ${currentRpcConfig.description}`);
    console.log(`[TransactionUtils] Configuration: skipPreflight=${skipPreflight}, commitment=${commitment}`);

    // Add priority fee instructions
    addPriorityFeeInstructions(transaction, priorityFeeMicrolamports, computeUnitLimit);

    let retries = 0;
    let lastSignature = null;

    while (retries < maxRetries) {
        try {
            console.log(`[TransactionUtils] Attempt ${retries + 1}/${maxRetries}: Preparing transaction...`);
            
            // CRITICAL: Check if last transaction succeeded before retrying
            if (lastSignature) {
                console.log(`[TransactionUtils] Checking if previous transaction already succeeded...`);
                const statusCheck = await checkTransactionStatus(connection, lastSignature);
                
                if (statusCheck.confirmed) {
                    console.log(`[TransactionUtils] ✅ Previous transaction already confirmed! Returning: ${lastSignature}`);
                    return lastSignature;
                } else if (statusCheck.error) {
                    console.log(`[TransactionUtils] Previous transaction failed definitively, proceeding with new attempt`);
                }
            }
            
            // Get FRESH blockhash for each attempt - CRITICAL for avoiding expiry
            const latestBlockhash = await rateLimitedRpcCall(async () => {
                return await connection.getLatestBlockhash(commitment);
            });
            
            transaction.recentBlockhash = latestBlockhash.blockhash;
            transaction.feePayer = signers[0].publicKey;

            console.log(`[TransactionUtils] Fresh blockhash: ${latestBlockhash.blockhash.slice(0, 8)}... Valid until: ${latestBlockhash.lastValidBlockHeight}`);

            // Sign transaction
            transaction.sign(...signers);
            
            // Send transaction immediately
            const rawTransaction = transaction.serialize();
            console.log(`[TransactionUtils] Sending transaction (${rawTransaction.length} bytes)...`);
            
            // Send with optimized settings for current RPC type
            lastSignature = await rateLimitedRpcCall(async () => {
                return await connection.sendRawTransaction(rawTransaction, {
                    skipPreflight: skipPreflight,
                    preflightCommitment: commitment,
                    maxRetries: 0 // Disable built-in retries for manual control
                });
            });

            console.log(`[TransactionUtils] Transaction sent: ${lastSignature}`);
            console.log(`[TransactionUtils] Solscan: https://solscan.io/tx/${lastSignature}?cluster=mainnet-beta`);

            // ADVANCED confirmation using WebSocket with polling fallback
            await confirmTransactionAdvanced(
                connection, 
                lastSignature, 
                latestBlockhash.blockhash, 
                latestBlockhash.lastValidBlockHeight, 
                commitment
            );

            console.log(`[TransactionUtils] ✅ Transaction SUCCESS: ${lastSignature}`);
            return lastSignature;

        } catch (error) {
            console.warn(`[TransactionUtils] ❌ Attempt ${retries + 1} failed: ${error.message}`);
            retries++;
            
            // Handle specific error types with appropriate responses
            if (error.message.includes('insufficient funds') || error.message.includes('Insufficient funds')) {
                console.error(`[TransactionUtils] 💰 Insufficient funds - stopping all retries`);
                throw error;
            }
            
            // For confirmation timeouts, check if transaction actually succeeded
            if (error.message.includes('timed out') || error.message.includes('block height exceeded')) {
                console.warn(`[TransactionUtils] ⏰ Confirmation issue - will check transaction status`);
                
                if (lastSignature) {
                    console.log(`[TransactionUtils] Doing final check for signature: ${lastSignature.slice(0, 8)}...`);
                    // Give network a moment to propagate
                    await sleep(2000);
                    
                    const finalCheck = await checkTransactionStatus(connection, lastSignature);
                    if (finalCheck.confirmed) {
                        console.log(`[TransactionUtils] ✅ Transaction actually succeeded! Returning: ${lastSignature}`);
                        return lastSignature;
                    }
                }
            }
            
            if (retries >= maxRetries) {
                console.error(`[TransactionUtils] 🚫 All retries exhausted after ${maxRetries} attempts`);
                throw new Error(`Transaction failed after ${maxRetries} attempts: ${error.message}`);
            }

            // Smart backoff based on error type and RPC configuration
            let backoffTime;
            if (error.message.includes('block height exceeded') || error.message.includes('timed out')) {
                backoffTime = 500; // Quick retry with fresh blockhash for timing issues
            } else if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
                backoffTime = currentRpcConfig.retryBackoff; // Use RPC-specific backoff
            } else if (error.message.includes('blockhash not found')) {
                backoffTime = 1000; // Medium delay for blockhash propagation
            } else {
                backoffTime = 1500; // Standard delay for other errors
            }
            
            console.log(`[TransactionUtils] ⏳ Retrying in ${backoffTime}ms...`);
            await sleep(backoffTime);
        }
    }
    
    throw new Error('Transaction failed after all retries - this should not be reached');
}

/**
 * Creates a basic SOL transfer transaction.
 * @param {web3.PublicKey} fromPubkey - Sender's public key.
 * @param {web3.PublicKey} toPubkey - Receiver's public key.
 * @param {number} lamports - Amount to transfer in lamports.
 * @returns {web3.Transaction} The transaction with transfer instruction.
 */
function createSolTransferTransaction(fromPubkey, toPubkey, lamports) {
    console.log(`[TransactionUtils] Creating SOL transfer: ${lamports} lamports from ${fromPubkey.toBase58().slice(0, 8)}... to ${toPubkey.toBase58().slice(0, 8)}...`);
    
    const transaction = new web3.Transaction();
    
    const transferInstruction = web3.SystemProgram.transfer({
        fromPubkey: fromPubkey,
        toPubkey: toPubkey,
        lamports: lamports
    });
    
    transaction.add(transferInstruction);
    return transaction;
}

/**
 * Converts SOL amount to lamports.
 * @param {number} solAmount - Amount in SOL.
 * @returns {number} Amount in lamports.
 */
function solToLamports(solAmount) {
    return Math.floor(solAmount * web3.LAMPORTS_PER_SOL);
}

/**
 * Converts lamports to SOL.
 * @param {number} lamports - Amount in lamports.
 * @returns {number} Amount in SOL.
 */
function lamportsToSol(lamports) {
    return lamports / web3.LAMPORTS_PER_SOL;
}

/**
 * Estimates the transaction fee for a given transaction.
 * @param {web3.Connection} connection - Solana connection object.
 * @param {web3.Transaction} transaction - The transaction to estimate fees for.
 * @param {web3.Signer[]} signers - Array of signers for the transaction.
 * @returns {Promise<number>} Estimated fee in lamports.
 */
async function estimateTransactionFee(connection, transaction, signers) {
    try {
        console.log(`[TransactionUtils] Estimating transaction fee...`);
        
        // Get recent blockhash
        const { blockhash } = await getRecentBlockhash(connection);
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = signers[0].publicKey;
        
        // Get fee for transaction with rate limiting
        const fee = await rateLimitedRpcCall(async () => {
            return await connection.getFeeForMessage(transaction.compileMessage());
        });
        
        const estimatedFee = fee.value || 5000; // Default fallback fee
        
        console.log(`[TransactionUtils] Estimated fee: ${estimatedFee} lamports (${lamportsToSol(estimatedFee)} SOL)`);
        return estimatedFee;
    } catch (error) {
        console.warn(`[TransactionUtils] Error estimating transaction fee: ${error.message}`);
        return 5000; // Default fallback fee
    }
}

/**
 * Gets dynamic priority fee recommendations
 * @param {web3.Connection} connection - Solana connection object
 * @param {web3.PublicKey[]} [accounts] - Accounts involved in the transaction
 * @returns {Promise<number>} Recommended priority fee in microlamports
 */
async function getDynamicPriorityFee(connection, accounts = []) {
    try {
        console.log(`[TransactionUtils] Getting dynamic priority fee...`);
        
        // Try to get recent prioritization fees with rate limiting protection
        if (connection.getRecentPrioritizationFees) {
            const recentFees = await rateLimitedRpcCall(async () => {
                return await connection.getRecentPrioritizationFees({
                    lockedWritableAccounts: accounts.slice(0, 5)
                });
            });
            
            if (recentFees && recentFees.length > 0) {
                // Use 90th percentile for higher success rate
                const sortedFees = recentFees
                    .map(fee => fee.prioritizationFee)
                    .sort((a, b) => a - b);
                
                const percentile90Index = Math.floor(sortedFees.length * 0.9);
                const recommendedFee = Math.max(sortedFees[percentile90Index] || 100000, 50000);
                
                console.log(`[TransactionUtils] Dynamic priority fee (90th percentile): ${recommendedFee} microlamports`);
                return recommendedFee;
            }
        }
        
        console.log(`[TransactionUtils] Using fallback priority fee: 100000 microlamports`);
        return 100000;
    } catch (error) {
        console.warn(`[TransactionUtils] Error getting dynamic priority fee: ${error.message}`);
        return 100000;
    }
}

// ============================================================================
// JUPITER-SPECIFIC TRANSACTION UTILITIES
// ============================================================================

/**
 * Handles priority fee instructions for VersionedTransaction objects from Jupiter.
 * Note: VersionedTransaction objects don't support manual priority fee modification
 * as they are pre-optimized and handle priority fees internally.
 * @param {web3.VersionedTransaction} transaction - The VersionedTransaction to check.
 * @param {number} [priorityFeeMicrolamports=100000] - Priority fee in microlamports (ignored for VersionedTransaction).
 * @param {number} [computeUnitLimit=200000] - Compute unit limit (ignored for VersionedTransaction).
 * @returns {web3.VersionedTransaction} The transaction (unchanged for VersionedTransaction).
 */
function addPriorityFeeInstructionsVersioned(transaction, priorityFeeMicrolamports = 100000, computeUnitLimit = 200000) {
    if (transaction instanceof web3.VersionedTransaction) {
        console.log(`[TransactionUtils] VersionedTransaction detected - priority fees handled internally by Jupiter`);
        return transaction; // Return as-is, Jupiter handles priority fees internally
    }
    
    console.warn(`[TransactionUtils] addPriorityFeeInstructionsVersioned called with non-VersionedTransaction - use addPriorityFeeInstructions instead`);
    return transaction;
}

/**
 * Sends and confirms a pre-signed VersionedTransaction from Jupiter.
 * This is a simplified sender that does not modify the transaction, as Jupiter transactions
 * are pre-optimized and have their own expiry mechanisms.
 * @param {web3.Connection} connection - Solana connection object.
 * @param {web3.VersionedTransaction} transaction - The pre-signed versioned transaction.
 * @param {object} [options] - Optional parameters.
 * @param {web3.Commitment} [options.commitment='confirmed'] - Desired commitment level.
 * @returns {Promise<string>} The transaction signature.
 */
async function sendAndConfirmVersionedTransaction(connection, transaction, options = {}) {
    const { commitment = 'confirmed' } = options;

    console.log(`[TransactionUtils] Sending pre-signed VersionedTransaction...`);
    
    const rawTransaction = transaction.serialize();
    const signature = await rateLimitedRpcCall(async () => {
        return await connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true, // Recommended for Jupiter txs
            preflightCommitment: commitment,
        });
    });

    console.log(`[TransactionUtils] Transaction sent: ${signature}`);
    console.log(`[TransactionUtils] Solscan: https://solscan.io/tx/${signature}?cluster=mainnet-beta`);

    const latestBlockhash = await getRecentBlockhash(connection, commitment);

    await confirmTransactionAdvanced(
        connection, 
        signature, 
        latestBlockhash.blockhash,
        latestBlockhash.lastValidBlockHeight, 
        commitment
    );

    console.log(`[TransactionUtils] ✅ VersionedTransaction SUCCESS: ${signature}`);
    return signature;
}

// ============================================================================
// JITO-SPECIFIC FUNCTIONS (PRESERVED FROM ORIGINAL)
// ============================================================================

// Constants for Jito interactions (can be made configurable)
const MAX_RETRIES_JITO_SEND = 7;
const INITIAL_RETRY_DELAY_JITO_SEND = 2000;
const MAX_RETRY_DELAY_JITO_SEND = 30000;
const BUNDLE_STATUS_POLL_INTERVAL = 2000;
const BUNDLE_STATUS_POLL_ATTEMPTS = 10; // Default, can be overridden
const JITO_REGIONAL_ENDPOINT = 'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles'; // Default, can be overridden

/**
 * Sends a bundle of transactions to the Jito Block Engine with retries.
 * Enhanced with optional RPC config integration and improved error context.
 * @param {string[]} encodedSignedTxs_base58 - Array of base58 encoded signed transactions.
 * @param {object} [jitoOptions] - Options for Jito interaction.
 * @param {string} [jitoOptions.jitoEndpoint] - Jito regional endpoint.
 * @param {number} [jitoOptions.maxRetries] - Max retries for sending.
 * @param {number} [jitoOptions.initialDelay] - Initial retry delay.
 * @param {number} [jitoOptions.maxDelay] - Max retry delay.
 * @param {boolean} [jitoOptions.useRpcConfig] - Use RPC config for adaptive timing.
 * @returns {Promise<string>} The bundle ID.
 */
async function sendJitoBundleWithRetries(encodedSignedTxs_base58, jitoOptions = {}) {
    const endpoint = jitoOptions.jitoEndpoint || JITO_REGIONAL_ENDPOINT;
    const maxRetries = jitoOptions.maxRetries || MAX_RETRIES_JITO_SEND;
    
    // Optional RPC config integration for adaptive timing
    let currentDelay = jitoOptions.initialDelay || INITIAL_RETRY_DELAY_JITO_SEND;
    const maxDelay = jitoOptions.maxDelay || MAX_RETRY_DELAY_JITO_SEND;
    
    if (jitoOptions.useRpcConfig && currentRpcConfig) {
        console.log(`[TransactionUtils] Using RPC config adaptive timing for Jito bundle`);
        currentDelay = Math.max(currentDelay, currentRpcConfig.retryBackoff / 2); // Conservative adaptation
    }

    let retryCount = 0;
    while (retryCount < maxRetries) {
        try {
            console.log(`[TransactionUtils] Attempting to send Jito bundle (attempt ${retryCount + 1}/${maxRetries}) to ${endpoint}...`);
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
                console.log(`[TransactionUtils] ✅ Jito bundle sent successfully: ${data.result} (${encodedSignedTxs_base58.length} transactions)`);
                return data.result; // Bundle ID
            }

            const errorText = await response.text();
            if (response.status === 429) { // Rate limited
                const retryAfterHeader = response.headers.get('Retry-After');
                const waitTime = retryAfterHeader ? parseInt(retryAfterHeader) * 1000 : currentDelay;
                console.warn(`[TransactionUtils] Rate limited by Jito sendBundle. Waiting ${waitTime/1000} seconds...`);
                await sleep(waitTime);
                currentDelay = Math.min(currentDelay * 2, maxDelay);
            } else {
                throw new Error(`Failed to send Jito bundle: HTTP ${response.status}. Response: ${errorText}`);
            }
        } catch (error) {
            console.warn(`[TransactionUtils] Error in sendJitoBundleWithRetries (attempt ${retryCount + 1}/${maxRetries}): ${error.message}`);
            if (retryCount >= maxRetries - 1) {
                console.error(`[TransactionUtils] ❌ Jito bundle failed after ${maxRetries} attempts. Final error: ${error.message}`);
                throw error; // Last attempt failed
            }
            await sleep(currentDelay);
            currentDelay = Math.min(currentDelay * 2, maxDelay); // Increase delay for next retry
        }
        retryCount++;
    }
    throw new Error(`Failed to send Jito bundle to ${endpoint} after ${maxRetries} attempts.`);
}

/**
 * Polls Jito for the status of a bundle.
 * Enhanced with improved error context and adaptive timing.
 * @param {string} bundleId - The ID of the bundle to poll.
 * @param {object} [jitoOptions] - Options for Jito interaction.
 * @param {string} [jitoOptions.jitoEndpoint] - Jito regional endpoint.
 * @param {number} [jitoOptions.pollAttempts] - Number of polling attempts.
 * @param {number} [jitoOptions.pollInterval] - Interval between polls in ms.
 * @param {boolean} [jitoOptions.useRpcConfig] - Use RPC config for adaptive timing.
 * @returns {Promise<'landed' | 'failed_or_dropped' | 'indeterminate'>} The status of the bundle.
 */
async function pollBundleStatus(bundleId, jitoOptions = {}) {
    const endpoint = jitoOptions.jitoEndpoint || JITO_REGIONAL_ENDPOINT;
    const pollAttempts = jitoOptions.pollAttempts || BUNDLE_STATUS_POLL_ATTEMPTS;
    let pollInterval = jitoOptions.pollInterval || BUNDLE_STATUS_POLL_INTERVAL;
    
    // Optional RPC config integration for adaptive polling
    if (jitoOptions.useRpcConfig && currentRpcConfig) {
        console.log(`[TransactionUtils] Using RPC config adaptive timing for bundle polling`);
        pollInterval = Math.max(pollInterval, currentRpcConfig.rpcCallInterval * 2); // Conservative adaptation
    }

    console.log(`[TransactionUtils] Polling Jito for bundle status of ${bundleId} (up to ${pollAttempts} attempts, interval ${pollInterval}ms) at ${endpoint}...`);
    for (let attempts = 0; attempts < pollAttempts; attempts++) {
        await sleep(pollInterval);
        if (attempts === 0 || (attempts + 1) % 5 === 0 || attempts === pollAttempts -1 ) {
             console.log(`[TransactionUtils] Polling attempt ${attempts + 1}/${pollAttempts} for bundle ${bundleId}...`);
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
                    console.warn(`[TransactionUtils] Jito getBundleStatuses RPC error for ${bundleId}: ${data.error.message}`);
                    continue; // Try next attempt
                }
                if (data.result && data.result.value && data.result.value.length > 0) {
                    const statusInfo = data.result.value[0];
                    console.log(`[TransactionUtils] Bundle ${bundleId} Jito confirmation_status: ${statusInfo.confirmation_status}, Error: ${JSON.stringify(statusInfo.err)}`);
                    
                    // Check for explicit error in the bundle transaction itself, even if Jito processed it
                    if (statusInfo.err && (typeof statusInfo.err === 'string' && statusInfo.err.toLowerCase() !== 'ok' && statusInfo.err !== null) || 
                        (typeof statusInfo.err === 'object' && statusInfo.err !== null && !statusInfo.err.hasOwnProperty('Ok'))) {
                        console.error(`[TransactionUtils] Bundle ${bundleId} processed by Jito but with an error state:`, statusInfo.err);
                        return 'failed_or_dropped';
                    }

                    // Check confirmation status
                    const confirmationStatus = statusInfo.confirmation_status ? statusInfo.confirmation_status.toLowerCase() : null;
                    if (confirmationStatus === 'processed' || confirmationStatus === 'confirmed' || confirmationStatus === 'finalized') {
                        console.log(`[TransactionUtils] ✅ Bundle ${bundleId} landed successfully!`);
                        return 'landed';
                    } else if (confirmationStatus === 'failed' || confirmationStatus === 'dropped') {
                        console.error(`[TransactionUtils] Bundle ${bundleId} explicitly failed or was dropped by Jito. Error:`, statusInfo.err);
                        return 'failed_or_dropped';
                    }
                }
            } else {
                const errorText = await response.text();
                console.warn(`[TransactionUtils] Jito getBundleStatuses HTTP error for ${bundleId} (attempt ${attempts + 1}): ${response.status} ${errorText}`);
            }
        } catch (error) {
            console.warn(`[TransactionUtils] Error polling Jito bundle status for ${bundleId} (attempt ${attempts + 1}): ${error.message}`);
        }
    }
    console.warn(`[TransactionUtils] ⏰ Bundle ${bundleId} status indeterminate after ${pollAttempts} attempts (${pollAttempts * pollInterval / 1000}s total)`);
    return 'indeterminate';
}

module.exports = {
    // Enhanced transaction functions
    addPriorityFeeInstructions,
    sendAndConfirmTransactionRobustly,
    createSolTransferTransaction,
    solToLamports,
    lamportsToSol,
    estimateTransactionFee,
    getDynamicPriorityFee,
    getRecentBlockhash,
    calculateTransactionFee,
    confirmTransactionAdvanced,
    checkTransactionStatus,
    sleep,
    rateLimitedRpcCall,
    getRpcConfig: () => currentRpcConfig,
    RPC_CONFIGS,
    // Jupiter-specific functions
    addPriorityFeeInstructionsVersioned,
    sendAndConfirmVersionedTransaction,
    // Jito functions (preserved)
    sendJitoBundleWithRetries,
    pollBundleStatus,
    // Make constants available for configuration if needed by services
    MAX_RETRIES_JITO_SEND,
    INITIAL_RETRY_DELAY_JITO_SEND,
    MAX_RETRY_DELAY_JITO_SEND,
    BUNDLE_STATUS_POLL_INTERVAL,
    BUNDLE_STATUS_POLL_ATTEMPTS,
    JITO_REGIONAL_ENDPOINT
}; 
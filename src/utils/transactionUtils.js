const web3 = require('@solana/web3.js');

const bs58 = require('bs58');

/**
 * RPC Provider Configuration for optimal settings
 * These settings are optimized for each provider type
 */
const RPC_CONFIGS = {
    // Public mainnet-beta (free tier) - Optimized for official limits
    // Official limits: 100 req/10s total, 40 req/10s per method, 40 concurrent connections
    // Per method limit: 40 req/10s = 4 RPS = 250ms minimum interval per method
    PUBLIC: {
        name: 'Public Mainnet-Beta',
        rpcCallInterval: 3000, // 2500ms between calls (4 req/10s = safe margin under 40 req/10s per method)
        maxConcurrentRequests: 2, // Single concurrent request to avoid method-specific bursts
        retryBackoff: 500, // 3s initial backoff for 429 errors (reduced from 15s)
        confirmationTimeout: 9000, // 20s confirmation timeout
        useWebSocket: true, // Always use WebSocket to avoid polling overhead
        description: 'Free public RPC optimized for 40 req/10s per method limit'
    },

    // Premium providers (QuickNode, Helius, Alchemy) - relaxed settings
    PREMIUM: {
        name: 'Premium RPC Provider',
        rpcCallInterval: 100, // 100ms between calls (higher limits)
        maxConcurrentRequests: 4, // More concurrent requests allowed
        retryBackoff: 500, // 1s backoff
        confirmationTimeout: 5000, // 10s confirmation timeout
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
 * @param {number} [priorityFeeMicrolamports=200000] - Priority fee in microlamports.
 * @param {number} [computeUnitLimit=300000] - Compute unit limit.
 * @returns {web3.Transaction} The transaction with priority fee instructions added.
 */
function addPriorityFeeInstructions(transaction, priorityFeeMicrolamports = 200000, computeUnitLimit = 300000) {
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
                connection.removeSignatureListener(subId).catch(() => { });
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
function calculateTransactionFee(priorityFeeMicrolamports = 200000, computeUnitLimit = 300000) {
    const baseFee = 5000; // Base transaction fee in lamports
    const priorityFeeInLamports = Math.ceil((priorityFeeMicrolamports * computeUnitLimit) / 1000000);
    const totalFee = baseFee + priorityFeeInLamports;

    console.log(`[TransactionUtils] Fee calculation: Base=${baseFee}, Priority=${priorityFeeInLamports}, Total=${totalFee} lamports`);
    return totalFee;
}

// MONOCODE Compliance: Enhanced rent calculation utilities for account creation
/**
 * Solana rent exemption constants based on official documentation
 * Source: https://docs.solanalabs.com/implemented-proposals/rent
 */
const SOLANA_RENT_CONSTANTS = {
    ACCOUNT_STORAGE_OVERHEAD: 128, // bytes
    DEFAULT_LAMPORTS_PER_BYTE_YEAR: 3480, // lamports per byte per year
    DEFAULT_EXEMPTION_THRESHOLD: 2.0, // 2 years of rent for exemption

    // Common account sizes for quick reference
    BASIC_ACCOUNT_SIZE: 0, // Basic SOL account (just overhead)
    TOKEN_ACCOUNT_SIZE: 165, // SPL Token account size
    MULTISIG_ACCOUNT_SIZE: 355, // Multisig account size
    MINT_ACCOUNT_SIZE: 82 // Token mint account size
};

/**
 * Calculates rent exemption requirement for a given account size
 * MONOCODE Compliance: Observable implementation with clear rent calculation
 * @param {number} accountDataSize - Size of account data in bytes (excluding overhead)
 * @returns {number} Rent exemption amount in lamports
 */
function calculateRentExemption(accountDataSize = 0) {
    const totalAccountSize = accountDataSize + SOLANA_RENT_CONSTANTS.ACCOUNT_STORAGE_OVERHEAD;
    const rentExemptionLamports = Math.ceil(
        totalAccountSize *
        SOLANA_RENT_CONSTANTS.DEFAULT_LAMPORTS_PER_BYTE_YEAR *
        SOLANA_RENT_CONSTANTS.DEFAULT_EXEMPTION_THRESHOLD
    );

    console.log(`[TransactionUtils] Rent calculation: ${accountDataSize} data bytes + ${SOLANA_RENT_CONSTANTS.ACCOUNT_STORAGE_OVERHEAD} overhead = ${totalAccountSize} total bytes`);
    console.log(`[TransactionUtils] Rent exemption: ${rentExemptionLamports} lamports (${(rentExemptionLamports / web3.LAMPORTS_PER_SOL).toFixed(8)} SOL)`);

    return rentExemptionLamports;
}

/**
 * Gets rent exemption amount for common account types
 * MONOCODE Compliance: Explicit error handling with predefined account types
 * @param {string} accountType - Type of account ('basic', 'token', 'mint', 'multisig')
 * @returns {number} Rent exemption amount in lamports
 */
function getRentExemptionForAccountType(accountType) {
    const accountSizes = {
        'basic': SOLANA_RENT_CONSTANTS.BASIC_ACCOUNT_SIZE,
        'token': SOLANA_RENT_CONSTANTS.TOKEN_ACCOUNT_SIZE,
        'ATA': SOLANA_RENT_CONSTANTS.TOKEN_ACCOUNT_SIZE, // Alias for Associated Token Account
        'mint': SOLANA_RENT_CONSTANTS.MINT_ACCOUNT_SIZE,
        'multisig': SOLANA_RENT_CONSTANTS.MULTISIG_ACCOUNT_SIZE
    };

    if (!(accountType in accountSizes)) {
        throw new Error(`Unknown account type: ${accountType}. Supported types: ${Object.keys(accountSizes).join(', ')}`);
    }

    const accountSize = accountSizes[accountType];
    const rentLamports = calculateRentExemption(accountSize);

    console.log(`[TransactionUtils] ${accountType} account rent exemption: ${rentLamports} lamports (${(rentLamports / web3.LAMPORTS_PER_SOL).toFixed(8)} SOL)`);
    return rentLamports;
}

/**
 * Calculates total cost for operations that may create accounts
 * MONOCODE Compliance: Progressive construction with comprehensive cost calculation
 * @param {Object} options - Configuration object
 * @param {number} [options.priorityFeeMicrolamports=200000] - Priority fee in microlamports
 * @param {number} [options.computeUnitLimit=300000] - Compute unit limit
 * @param {string[]} [options.accountTypesToCreate=[]] - Types of accounts that will be created
 * @param {boolean} [options.includeRentBuffer=true] - Whether to include a safety buffer for rent
 * @returns {Object} Cost breakdown with transaction fees and rent requirements
 */
function calculateTransactionCostWithRent(options = {}) {
    const {
        priorityFeeMicrolamports = 200000,
        computeUnitLimit = 300000,
        accountTypesToCreate = [],
        includeRentBuffer = true
    } = options;

    // Calculate base transaction fee
    const transactionFee = calculateTransactionFee(priorityFeeMicrolamports, computeUnitLimit);

    // Calculate rent requirements for new accounts
    let totalRentRequired = 0;
    const rentBreakdown = {};

    for (const accountType of accountTypesToCreate) {
        try {
            const rentAmount = getRentExemptionForAccountType(accountType);
            totalRentRequired += rentAmount;
            rentBreakdown[accountType] = rentAmount;
        } catch (error) {
            console.warn(`[TransactionUtils] Could not calculate rent for account type ${accountType}: ${error.message}`);
        }
    }

    // Add safety buffer if requested (10% of total rent)
    const rentBuffer = includeRentBuffer ? Math.ceil(totalRentRequired * 0.1) : 0;
    const totalCost = transactionFee + totalRentRequired + rentBuffer;

    const result = {
        transactionFee,
        rentCost: totalRentRequired, // Explicit rent cost for easier access
        buffer: rentBuffer,
        totalCost,
        rentBreakdown,
        totalCostSOL: totalCost / web3.LAMPORTS_PER_SOL,
        summary: {
            transactionFeeSOL: transactionFee / web3.LAMPORTS_PER_SOL,
            totalRentRequiredSOL: totalRentRequired / web3.LAMPORTS_PER_SOL,
            rentBufferSOL: rentBuffer / web3.LAMPORTS_PER_SOL
        }
    };

    console.log(`[TransactionUtils] ✅ Total cost calculation:`);
    console.log(`[TransactionUtils]   Transaction fee: ${result.summary.transactionFeeSOL.toFixed(8)} SOL`);
    console.log(`[TransactionUtils]   Rent required: ${result.summary.totalRentRequiredSOL.toFixed(8)} SOL`);
    console.log(`[TransactionUtils]   Rent buffer: ${result.summary.rentBufferSOL.toFixed(8)} SOL`);
    console.log(`[TransactionUtils]   Total cost: ${result.totalCostSOL.toFixed(8)} SOL`);

    return result;
}

/**
 * Validates if an account has sufficient balance for operations that may create accounts
 * MONOCODE Compliance: Explicit error handling with detailed validation
 * @param {number} accountBalanceSOL - Current account balance in SOL
 * @param {Object} costCalculation - Result from calculateTransactionCostWithRent
 * @param {number} [additionalSOLSpend=0] - Additional SOL that will be spent (e.g., token purchases)
 * @returns {Object} Validation result with detailed information
 */
function validateBalanceForRentOperations(accountBalanceSOL, costCalculation, additionalSOLSpend = 0) {
    const totalRequired = costCalculation.totalCostSOL + additionalSOLSpend;
    const isValid = accountBalanceSOL >= totalRequired;
    const shortfall = isValid ? 0 : totalRequired - accountBalanceSOL;

    const result = {
        isValid,
        accountBalance: accountBalanceSOL,
        totalRequired,
        shortfall,
        breakdown: {
            transactionFee: costCalculation.summary.transactionFeeSOL,
            rentRequirements: costCalculation.summary.totalRentRequiredSOL,
            rentBuffer: costCalculation.summary.rentBufferSOL,
            additionalSpend: additionalSOLSpend
        }
    };

    if (isValid) {
        console.log(`[TransactionUtils] ✅ Balance validation passed: ${accountBalanceSOL} SOL >= ${totalRequired.toFixed(8)} SOL required`);
    } else {
        console.warn(`[TransactionUtils] ❌ Insufficient balance: ${accountBalanceSOL} SOL < ${totalRequired.toFixed(8)} SOL required (shortfall: ${shortfall.toFixed(8)} SOL)`);
        console.warn(`[TransactionUtils] Breakdown: TX fee ${result.breakdown.transactionFee.toFixed(8)} + Rent ${result.breakdown.rentRequirements.toFixed(8)} + Buffer ${result.breakdown.rentBuffer.toFixed(8)} + Additional ${result.breakdown.additionalSpend.toFixed(8)} SOL`);
    }

    return result;
}

/**
 * Enhanced transaction sender with ADVANCED confirmation and smart fallback
 * Uses WebSocket-based confirmation with polling fallback to avoid rate limits
 * Includes duplicate transaction prevention based on research findings
 * MONOCODE Compliance: Fixed insufficient funds detection and improved error handling
 * @param {web3.Connection} connection - Solana connection object.
 * @param {web3.Transaction} transaction - The transaction to send.
 * @param {web3.Signer[]} signers - Array of signers for the transaction.
 * @param {object} [options] - Optional parameters.
 * @param {boolean} [options.skipPreflight=false] - Whether to skip preflight simulation.
 * @param {number} [options.maxRetries=3] - Maximum retries for sending/confirming.
 * @param {web3.Commitment} [options.commitment='confirmed'] - Desired commitment level.
 * @param {number} [options.priorityFeeMicrolamports=200000] - Priority fee in microlamports.
 * @param {number} [options.computeUnitLimit=300000] - Compute unit limit.
 * @returns {Promise<string>} The transaction signature.
 */
async function sendAndConfirmTransactionRobustly(connection, transaction, signers, options = {}) {
    const {
        skipPreflight = true,
        maxRetries = 3,
        commitment = 'confirmed',
        priorityFeeMicrolamports = 200000,
        computeUnitLimit = 300000
    } = options;

    console.log(`[TransactionUtils] Starting ADVANCED transaction strategy with ${maxRetries} max retries`);
    console.log(`[TransactionUtils] RPC Config: ${currentRpcConfig.name} - ${currentRpcConfig.description}`);
    console.log(`[TransactionUtils] Configuration: skipPreflight=${skipPreflight}, commitment=${commitment}`);

    // Compute budget instructions will be applied per-attempt with dynamic compute unit tuning

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

            // Apply dynamic compute unit limit per attempt (+10% each retry)
            const attemptFactor = Math.pow(1.1, retries);
            const adjustedComputeUnitLimit = Math.floor(computeUnitLimit * attemptFactor);

            // Remove any existing compute budget instructions from previous attempts
            transaction.instructions = transaction.instructions.filter(ix => !ix.programId.equals(web3.ComputeBudgetProgram.programId));

            // Re-apply compute budget with adjusted limit, keeping priority fee the same
            addPriorityFeeInstructions(transaction, priorityFeeMicrolamports, adjustedComputeUnitLimit);
            console.log(`[TransactionUtils] Retry tuning: compute unit limit adjusted to ${adjustedComputeUnitLimit} (base ${computeUnitLimit}, factor ${attemptFactor.toFixed(2)})`);

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

            // MONOCODE Compliance: Enhanced error handling for insufficient funds
            // Check for multiple variations of insufficient funds errors including custom program error 1
            if (error.message.includes('insufficient funds') ||
                error.message.includes('Insufficient funds') ||
                error.message.includes('insufficient lamports') ||
                error.message.includes('custom program error: 0x1') ||
                error.message.includes('custom program error: 1')) {
                console.error(`[TransactionUtils] 💰 Insufficient funds detected - stopping all retries`);
                console.error(`[TransactionUtils] Error details: ${error.message}`);
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
 * @param {number} [priorityFeeMicrolamports=200000] - Priority fee in microlamports (ignored for VersionedTransaction).
 * @param {number} [computeUnitLimit=300000] - Compute unit limit (ignored for VersionedTransaction).
 * @returns {web3.VersionedTransaction} The transaction (unchanged for VersionedTransaction).
 */
function addPriorityFeeInstructionsVersioned(transaction, priorityFeeMicrolamports = 200000, computeUnitLimit = 300000) {
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

    // MONOCODE Compliance: New rent calculation utilities
    calculateRentExemption,
    getRentExemptionForAccountType,
    calculateTransactionCostWithRent,
    validateBalanceForRentOperations,
    SOLANA_RENT_CONSTANTS,

    // Jupiter-specific functions
    addPriorityFeeInstructionsVersioned,
    sendAndConfirmVersionedTransaction,


}; 
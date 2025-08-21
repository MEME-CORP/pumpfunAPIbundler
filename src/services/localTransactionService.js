/**
 * LOCAL TRANSACTION SERVICE - Pump Portal Integration
 * 
 * This service handles local transactions via Pump Portal API to replace Jito bundles.
 * Uses parallel transaction groups of UNIFIED_PARALLEL_BATCH_SIZE (default 20) with 0.0005 SOL priority fee.
 * 
 * MONOCODE Compliance: Observable implementation with structured logging,
 * explicit error handling, and dependency transparency.
 */

const web3 = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = require('node-fetch');
const FormData = require('form-data'); // MONOCODE Fix: Use form-data package for proper multipart headers with node-fetch v2
const { getSolanaConnection } = require('../utils/walletUtils');
const { sleep, confirmTransactionAdvanced, rateLimitedRpcCall } = require('../utils/transactionUtils');

// Constants for local transactions
const PUMP_PORTAL_TRADE_LOCAL_ENDPOINT = 'https://pumpportal.fun/api/trade-local';
const DEFAULT_PRIORITY_FEE = 0.0005; // 0.0005 SOL as specified
const UNIFIED_PARALLEL_BATCH_SIZE = 20; // Single visible constant for all parallel batch processing
const FETCH_TIMEOUT_MS = 20000; // Abort fetch if Pump Portal hangs
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

/**
 * Creates a token using Pump Portal local transaction API
 * @param {object} tokenMetadata - Token metadata (name, symbol, description, etc.)
 * @param {string} imageUrl - IPFS URL for token image
 * @param {web3.Keypair} mintKeypair - Keypair for the new token mint
 * @param {web3.Keypair} signerKeypair - Keypair of the wallet creating the token
 * @param {number} devBuyAmount - Amount of SOL for dev buy (default 1 SOL)
 * @param {number} slippage - Slippage tolerance in basis points (default 1000 = 10%)
 * @returns {Promise<string>} Transaction signature
 */
async function createTokenLocalTransaction(tokenMetadata, metadataUri, mintKeypair, signerKeypair, devBuyAmount = 1, slippage = 1000) {
    console.log(`[LocalTransactionService] Creating token ${tokenMetadata.symbol} with dev buy of ${devBuyAmount} SOL`);
    
    try {
        // MONOCODE Fix: Use provided metadataUri instead of re-uploading metadata
        // This preserves the image reference that was uploaded in pumpService.js
        console.log(`[LocalTransactionService] Using provided metadata URI: ${metadataUri}`);

        // Get create transaction from Pump Portal
        const createRequestBody = {
            publicKey: signerKeypair.publicKey.toBase58(),
            action: "create",
            tokenMetadata: {
                name: tokenMetadata.name,
                symbol: tokenMetadata.symbol,
                uri: metadataUri
            },
            mint: mintKeypair.publicKey.toBase58(),
            denominatedInSol: "true",
            amount: devBuyAmount,
            slippage: slippage / 100, // Convert basis points to percentage
            priorityFee: DEFAULT_PRIORITY_FEE,
            pool: "pump"
        };

        console.log(`[LocalTransactionService] Requesting create transaction from Pump Portal...`);
        const createResponse = await fetch(PUMP_PORTAL_TRADE_LOCAL_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(createRequestBody),
            timeout: FETCH_TIMEOUT_MS
        });

        if (createResponse.status !== 200) {
            const errorText = await createResponse.text();
            throw new Error(`Create transaction request failed: ${createResponse.status} ${errorText}`);
        }

        // Deserialize and sign the transaction
        const transactionData = await createResponse.arrayBuffer();
        const transaction = web3.VersionedTransaction.deserialize(new Uint8Array(transactionData));
        transaction.sign([mintKeypair, signerKeypair]);

        // Send the transaction
        const connection = getSolanaConnection();
        const signature = await rateLimitedRpcCall(async () => {
            return await connection.sendTransaction(transaction);
        });
        console.log(`[LocalTransactionService] ✅ Token creation transaction sent: ${signature}`);

        return signature;

    } catch (error) {
        console.error(`[LocalTransactionService] ❌ Token creation failed: ${error.message}`);
        throw error;
    }
}

/**
 * Executes a buy or sell transaction using Pump Portal local transaction API
 * @param {string} action - "buy" or "sell"
 * @param {string} mintAddress - Token mint address
 * @param {web3.Keypair} signerKeypair - Wallet keypair
 * @param {number} amount - Amount to trade
 * @param {boolean} denominatedInSol - Whether amount is in SOL (true) or tokens (false)
 * @param {number} slippage - Slippage tolerance in basis points
 * @param {string} pool - Pool to use ("pump", "bonk", etc.)
 * @returns {Promise<string>} Transaction signature
 */
async function executeTradeLocalTransaction(action, mintAddress, signerKeypair, amount, denominatedInSol = true, slippage = 2500, pool = "pump") {
    console.log(`[LocalTransactionService] Executing ${action} for ${amount} ${denominatedInSol ? 'SOL' : 'tokens'} on ${mintAddress}`);
    
    try {
        // Guard against invalid sell amounts to prevent zero-amount attempts and redundant retries
        if (action === 'sell') {
            // Allow either a numeric token amount (>0) or a percentage string like "100%"
            if (typeof amount === 'string' && amount.trim().endsWith('%')) {
                const pct = parseFloat(amount.trim().replace('%', ''));
                if (Number.isNaN(pct) || pct <= 0 || pct > 100) {
                    throw new Error(`Invalid sell amount percentage: ${amount}. Must be between 0 and 100%.`);
                }
            } else {
                const amtNum = Number(amount);
                if (!Number.isFinite(amtNum) || amtNum <= 0) {
                    throw new Error(`Invalid sell amount: ${amount}. Must be > 0 tokens.`);
                }
                // Enforce integer token amount when denominatedInSol=false
                if (denominatedInSol === false && !Number.isInteger(amtNum)) {
                    amount = Math.floor(amtNum);
                }
            }
            if (denominatedInSol === true) {
                console.warn(`[LocalTransactionService] Warning: 'sell' with denominatedInSol=true; expected false (token amount).`);
            }
        }

        const requestBody = {
            publicKey: signerKeypair.publicKey.toBase58(),
            action: action,
            mint: mintAddress,
            denominatedInSol: denominatedInSol.toString(),
            amount: amount,
            slippage: slippage / 100, // Convert basis points to percentage
            priorityFee: DEFAULT_PRIORITY_FEE,
            pool: pool
        };
        
        // MONOCODE Fix: For sell operations, ensure amount is string when using percentage
        if (action === 'sell' && typeof amount === 'string' && amount.includes('%')) {
            requestBody.amount = amount; // Keep percentage as string
        }
        // Sanitized request log for debugging (no private keys)
        console.log(`[LocalTransactionService] trade-local request: action=${action}, mint=${mintAddress}, denominatedInSol=${denominatedInSol}, amount=${requestBody.amount}, slippage=${slippage / 100}, pool=${pool}`);

        const response = await fetch(PUMP_PORTAL_TRADE_LOCAL_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(requestBody),
            timeout: FETCH_TIMEOUT_MS
        });

        if (response.status !== 200) {
            const errorText = await response.text();
            throw new Error(`${action} transaction request failed: ${response.status} ${errorText}`);
        }

        // Deserialize and sign the transaction
        const transactionData = await response.arrayBuffer();
        const transaction = web3.VersionedTransaction.deserialize(new Uint8Array(transactionData));
        transaction.sign([signerKeypair]);

        // Send the transaction
        const connection = getSolanaConnection();
        const signature = await rateLimitedRpcCall(async () => {
            return await connection.sendTransaction(transaction);
        });
        console.log(`[LocalTransactionService] ✅ ${action} transaction sent: ${signature}`);

        return signature;

    } catch (error) {
        console.error(`[LocalTransactionService] ❌ ${action} transaction failed: ${error.message}`);
        throw error;
    }
}

/**
 * Executes multiple trade transactions in parallel batches.
 * @param {Array} transactionRequests - Array of transaction request objects
 * @param {number} batchSize - Number of transactions to process in parallel (auto-detected based on RPC)
 * @returns {Promise<Array>} Array of transaction signatures
 */
async function executeParallelTransactions(transactionRequests, batchSize = null) {
    // MONOCODE: Unified batch size for Pump Portal local API flows
    if (batchSize === null) {
        batchSize = UNIFIED_PARALLEL_BATCH_SIZE;
    }
    console.log(`[LocalTransactionService] Executing ${transactionRequests.length} transactions in parallel batches of ${batchSize}`);
    
    const results = [];
    const connection = getSolanaConnection();
    
    // Process transactions in batches
    for (let i = 0; i < transactionRequests.length; i += batchSize) {
        const batch = transactionRequests.slice(i, i + batchSize);
        console.log(`[LocalTransactionService] Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(transactionRequests.length/batchSize)} (${batch.length} transactions)`);
        
        // Execute batch in parallel
        const batchPromises = batch.map(async (request, index) => {
            try {
                const signature = await executeTradeLocalTransaction(
                    request.action,
                    request.mintAddress,
                    request.signerKeypair,
                    request.amount,
                    request.denominatedInSol,
                    request.slippage,
                    request.pool || "pump"
                );
                
                return {
                    success: true,
                    signature: signature,
                    walletName: request.walletName,
                    action: request.action,
                    amount: request.amount
                };
            } catch (error) {
                console.error(`[LocalTransactionService] Transaction failed for ${request.walletName}: ${error.message}`);
                return {
                    success: false,
                    error: error.message,
                    walletName: request.walletName,
                    action: request.action,
                    amount: request.amount
                };
            }
        });
        
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
        
        // Small delay between batches to avoid overwhelming the network
        if (i + batchSize < transactionRequests.length) {
            await sleep(500);
        }
    }
    
    const successCount = results.filter(r => r.success).length;
    console.log(`[LocalTransactionService] ✅ Parallel execution complete: ${successCount}/${results.length} transactions successful`);
    
    return results;
}

/**
 * Confirms a single transaction via WebSocket to avoid RPC rate limiting
 * @param {string} signature - Transaction signature to confirm
 * @param {string} commitment - Commitment level (default 'confirmed')
 * @param {number} timeoutMs - Timeout in milliseconds (default 30000)
 * @returns {Promise<boolean>} True if confirmed, false otherwise
 */
async function confirmTransactionViaWebSocket(signature, commitment = 'confirmed', timeoutMs = 30000) {
    const connection = getSolanaConnection();
    console.log(`[LocalTransactionService] Confirming transaction via WebSocket: ${signature.slice(0, 8)}...`);

    return new Promise((resolve) => {
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
                console.warn(`[LocalTransactionService] WebSocket confirmation timed out for ${signature.slice(0, 8)}`);
                resolve(false);
            } else if (result.err) {
                console.warn(`[LocalTransactionService] Transaction failed: ${signature.slice(0, 8)} - ${JSON.stringify(result.err)}`);
                resolve(false);
            } else {
                console.log(`[LocalTransactionService] ✅ Transaction confirmed via WebSocket: ${signature.slice(0, 8)}`);
                resolve(true);
            }
        };

        try {
            // Set up WebSocket listener for transaction signature
            subscriptionId = connection.onSignatureWithOptions(
                signature,
                (notificationResult, context) => {
                    console.log(`[LocalTransactionService] WebSocket notification received for ${signature.slice(0, 8)} in slot: ${context.slot}`);
                    handleResult(notificationResult);
                },
                { commitment: commitment }
            );

            // Set timeout with fallback RPC check
            timeoutId = setTimeout(async () => {
                if (resolved) return;

                console.log(`[LocalTransactionService] WebSocket timeout reached for ${signature.slice(0, 8)}, doing final RPC check...`);

                try {
                    const statusResult = await rateLimitedRpcCall(async () => {
                        return await connection.getSignatureStatus(signature);
                    });

                    if (statusResult && statusResult.value) {
                        const status = statusResult.value;
                        const isConfirmed = status.confirmationStatus === commitment ||
                            (commitment === 'confirmed' && status.confirmationStatus === 'finalized');

                        if (isConfirmed && !status.err) {
                            console.log(`[LocalTransactionService] ✅ Transaction confirmed by fallback RPC check: ${signature.slice(0, 8)}`);
                            handleResult(status);
                            return;
                        }
                    }

                    handleResult(null, true); // Timeout
                } catch (error) {
                    console.warn(`[LocalTransactionService] Fallback RPC check failed for ${signature.slice(0, 8)}: ${error.message}`);
                    handleResult(null, true); // Timeout
                }
            }, timeoutMs);

        } catch (error) {
            cleanup();
            console.warn(`[LocalTransactionService] WebSocket setup failed for ${signature.slice(0, 8)}: ${error.message}`);
            resolve(false);
        }
    });
}

/**
 * Confirms multiple transactions in parallel using WebSocket confirmations
 * @param {Array<string>} signatures - Array of transaction signatures to confirm
 * @param {string} commitment - Commitment level (default 'confirmed')
 * @param {number} timeoutMs - Timeout in milliseconds (default 30000)
 * @returns {Promise<Array>} Array of confirmation results
 */
async function confirmParallelTransactions(signatures, commitment = 'confirmed', timeoutMs = 30000) {
    console.log(`[LocalTransactionService] Confirming ${signatures.length} transactions in parallel via WebSocket...`);
    
    const confirmationPromises = signatures.map(async (signature) => {
        try {
            const confirmed = await confirmTransactionViaWebSocket(signature, commitment, timeoutMs);
            return { signature, confirmed };
        } catch (error) {
            console.warn(`[LocalTransactionService] Confirmation failed for ${signature}: ${error.message}`);
            return { signature, confirmed: false, error: error.message };
        }
    });
    
    const results = await Promise.all(confirmationPromises);
    const confirmedCount = results.filter(r => r.confirmed).length;
    console.log(`[LocalTransactionService] ✅ WebSocket confirmation complete: ${confirmedCount}/${signatures.length} transactions confirmed`);
    
    return results;
}

module.exports = {
    createTokenLocalTransaction,
    executeTradeLocalTransaction,
    confirmTransactionViaWebSocket,
    executeParallelTransactions,
    confirmParallelTransactions,
    
    // Constants
    PUMP_PORTAL_TRADE_LOCAL_ENDPOINT,
    DEFAULT_PRIORITY_FEE,
    UNIFIED_PARALLEL_BATCH_SIZE,
    FETCH_TIMEOUT_MS,
    MAX_RETRIES,
    RETRY_DELAY_MS
};

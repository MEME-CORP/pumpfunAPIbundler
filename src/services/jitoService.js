/**
 * JITO SERVICE - Centralized Jito Bundle Management
 * 
 * This module contains all Jito-related functionality extracted from transactionUtils.js
 * and pumpService.js to prepare for migration to local transactions.
 * 
 * MONOCODE Compliance: Observable implementation with structured logging,
 * explicit error handling for rate limiting, and dependency transparency.
 */

const fetch = require('node-fetch');
const { sleep, rateLimitedRpcCall, getRpcConfig } = require('../utils/transactionUtils');

// Constants for Jito interactions (can be made configurable)
const MAX_RETRIES_JITO_SEND = 3;
const INITIAL_RETRY_DELAY_JITO_SEND = 2000;
const MAX_RETRY_DELAY_JITO_SEND = 30000;
const BUNDLE_STATUS_POLL_INTERVAL = 2000;
const BUNDLE_STATUS_POLL_ATTEMPTS = 10; // Default, can be overridden

// MONOCODE Compliance: Centralized Jito endpoints for dynamic rotation
// Prioritized list of Jito Block Engine endpoints for rate limit resilience
const JITO_ENDPOINTS = [
    'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
    'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles', 
    'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles'
];

// Legacy endpoint constant for backward compatibility
const JITO_REGIONAL_ENDPOINT = JITO_ENDPOINTS[0]; // Default to first endpoint

// Global rate limiter for Jito bundle sends to prevent burst requests
const JITO_SEND_INTERVAL_MS = 1000; // 1 second minimum between bundle sends
let lastJitoBundleSend = 0;

/**
 * Sends a bundle of transactions to the Jito Block Engine with retries.
 * Enhanced with optional RPC config integration and improved error context.
 * Includes global rate limiting to prevent burst requests that cause 429 errors.
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
    const currentRpcConfig = getRpcConfig();

    // CRITICAL: Global rate limiting to prevent burst requests
    const now = Date.now();
    const timeSinceLastSend = now - lastJitoBundleSend;
    if (timeSinceLastSend < JITO_SEND_INTERVAL_MS) {
        const waitTime = JITO_SEND_INTERVAL_MS - timeSinceLastSend;
        console.log(`[JitoService] 🚦 Rate limiting Jito bundle send: waiting ${waitTime}ms to prevent burst requests`);
        await sleep(waitTime);
    }
    lastJitoBundleSend = Date.now();

    // Optional RPC config integration for adaptive timing
    let currentDelay = jitoOptions.initialDelay || INITIAL_RETRY_DELAY_JITO_SEND;
    const maxDelay = jitoOptions.maxDelay || MAX_RETRY_DELAY_JITO_SEND;

    if (jitoOptions.useRpcConfig && currentRpcConfig) {
        console.log(`[JitoService] Using RPC config adaptive timing for Jito bundle`);
        currentDelay = Math.max(currentDelay, currentRpcConfig.retryBackoff / 2); // Conservative adaptation
    }

    let retryCount = 0;
    while (retryCount < maxRetries) {
        try {
            console.log(`[JitoService] Attempting to send Jito bundle (attempt ${retryCount + 1}/${maxRetries}) to ${endpoint}...`);
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
                console.log(`[JitoService] ✅ Jito bundle sent successfully: ${data.result} (${encodedSignedTxs_base58.length} transactions)`);
                return data.result; // Bundle ID
            }

            const errorText = await response.text();
            if (response.status === 429) { // Rate limited
                // MONOCODE Compliance: Throw specific error for endpoint rotation
                const rateLimitError = new Error('JITO_RATE_LIMITED');
                rateLimitError.statusCode = 429;
                rateLimitError.endpoint = endpoint;
                rateLimitError.retryAfter = response.headers.get('Retry-After');
                console.warn(`[JitoService] ⚠️ Rate limited by Jito endpoint ${endpoint} (429). Endpoint rotation required.`);
                throw rateLimitError;
            } else {
                throw new Error(`Failed to send Jito bundle: HTTP ${response.status}. Response: ${errorText}`);
            }
        } catch (error) {
            console.warn(`[JitoService] Error in sendJitoBundleWithRetries (attempt ${retryCount + 1}/${maxRetries}): ${error.message}`);
            if (retryCount >= maxRetries - 1) {
                console.error(`[JitoService] ❌ Jito bundle failed after ${maxRetries} attempts. Final error: ${error.message}`);
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
 * Confirms a Jito bundle using ONLY WebSocket-based confirmation to avoid rate limiting.
 * This is the recommended approach for bundle confirmation as it eliminates Jito polling.
 * 
 * @param {web3.Connection} connection - Solana connection object
 * @param {string} firstSignature - The first transaction signature in the bundle
 * @param {object} [options] - Configuration options
 * @param {web3.Commitment} [options.commitment='confirmed'] - Commitment level
 * @param {number} [options.timeoutMs] - Timeout in milliseconds (defaults to RPC config)
 * @returns {Promise<object>} Bundle confirmation result with metadata
 */
async function confirmBundleWebSocketOnly(connection, firstSignature, options = {}) {
    const { commitment = 'confirmed', timeoutMs = null } = options;
    const startTime = Date.now();

    console.log(`[JitoService] 🔌 Starting WebSocket-ONLY bundle confirmation for: ${firstSignature.slice(0, 8)}...`);
    console.log(`[JitoService] This approach avoids Jito rate limiting by using Solana WebSocket notifications`);

    try {
        // Use the existing WebSocket confirmation function
        await waitForBundleViaWebSocket(connection, firstSignature, commitment, timeoutMs);

        const confirmationTime = Date.now() - startTime;
        const result = {
            confirmed: true,
            signature: firstSignature,
            method: 'websocket',
            confirmationTimeMs: confirmationTime,
            timestamp: Date.now()
        };

        console.log(`[JitoService] ✅ Bundle confirmed via WebSocket in ${confirmationTime}ms`);
        return result;

    } catch (error) {
        const confirmationTime = Date.now() - startTime;

        // Check if this was a timeout that might have actually succeeded
        if (error.message.includes('timed out') || error.message.includes('timeout')) {
            console.log(`[JitoService] ⏰ WebSocket timeout after ${confirmationTime}ms, checking final status via Solana RPC...`);

            try {
                const statusResult = await rateLimitedRpcCall(async () => {
                    return await connection.getSignatureStatus(firstSignature);
                });

                if (statusResult && statusResult.value) {
                    const status = statusResult.value;
                    const isConfirmed = status.confirmationStatus === commitment ||
                        (commitment === 'confirmed' && status.confirmationStatus === 'finalized');

                    if (isConfirmed && !status.err) {
                        console.log(`[JitoService] ✅ Bundle actually confirmed! Found via Solana RPC fallback`);
                        return {
                            confirmed: true,
                            signature: firstSignature,
                            method: 'rpc_fallback',
                            confirmationTimeMs: confirmationTime,
                            timestamp: Date.now()
                        };
                    }
                }
            } catch (fallbackError) {
                console.warn(`[JitoService] Solana RPC fallback check failed: ${fallbackError.message}`);
            }
        }

        console.error(`[JitoService] ❌ Bundle confirmation failed: ${error.message}`);
        throw new Error(`Bundle confirmation failed after ${confirmationTime}ms: ${error.message}`);
    }
}

/**
 * Waits for a bundle to be confirmed via WebSocket on the first transaction signature.
 * MONOCODE Fix: Eliminates Jito rate limiting by using WebSocket confirmation instead of polling.
 * Since Jito bundles are atomic, confirming the first transaction confirms the entire bundle.
 * @param {web3.Connection} connection - Solana connection object
 * @param {string} firstSignature - The first transaction signature in the bundle
 * @param {web3.Commitment} [commitment='confirmed'] - Commitment level
 * @param {number} [timeoutMs] - Timeout in milliseconds (defaults to RPC config)
 * @returns {Promise<void>} Resolves when bundle is confirmed, rejects on timeout/error
 */
async function waitForBundleViaWebSocket(connection, firstSignature, commitment = 'confirmed', timeoutMs = null) {
    const currentRpcConfig = getRpcConfig();
    const timeout = timeoutMs || currentRpcConfig.confirmationTimeout;
    console.log(`[JitoService] Waiting for bundle confirmation via WebSocket on signature: ${firstSignature.slice(0, 8)}...`);

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
                reject(new Error(`Bundle WebSocket confirmation timed out after ${timeout}ms`));
            } else if (result.err) {
                reject(new Error(`Bundle transaction failed: ${JSON.stringify(result.err)}`));
            } else {
                console.log(`[JitoService] ✅ Bundle confirmed via WebSocket! First transaction reached chain.`);
                resolve();
            }
        };

        try {
            // Set up WebSocket listener for the first transaction signature
            subscriptionId = connection.onSignatureWithOptions(
                firstSignature,
                (notificationResult, context) => {
                    console.log(`[JitoService] Bundle WebSocket notification received for signature: ${firstSignature.slice(0, 8)}... in slot: ${context.slot}`);
                    handleResult(notificationResult);
                },
                { commitment: commitment }
            );

            // Set timeout with fallback RPC check
            timeoutId = setTimeout(async () => {
                if (resolved) return;

                console.log(`[JitoService] Bundle WebSocket timeout reached, doing final RPC check...`);

                try {
                    const statusResult = await rateLimitedRpcCall(async () => {
                        return await connection.getSignatureStatus(firstSignature);
                    });

                    if (statusResult && statusResult.value) {
                        const status = statusResult.value;
                        const isConfirmed = status.confirmationStatus === commitment ||
                            (commitment === 'confirmed' && status.confirmationStatus === 'finalized');

                        if (isConfirmed && !status.err) {
                            console.log(`[JitoService] ✅ Bundle confirmed by fallback RPC check!`);
                            handleResult(status);
                            return;
                        }
                    }

                    handleResult(null, true); // Timeout
                } catch (error) {
                    console.warn(`[JitoService] Bundle fallback RPC check failed: ${error.message}`);
                    handleResult(null, true); // Timeout
                }
            }, timeout);

        } catch (error) {
            cleanup();
            reject(error);
        }
    });
}

/**
 * DEPRECATED: This function has been removed to prevent Jito rate limiting.
 * Use waitForBundleViaWebSocket() instead for bundle confirmation.
 * 
 * Jito polling causes rate limiting (429 errors) which prevents reliable bundle execution.
 * The WebSocket approach confirms bundles through Solana RPC without additional Jito calls.
 * 
 * @deprecated Use waitForBundleViaWebSocket() for bundle confirmation
 * @param {string} bundleId - The ID of the bundle (ignored)
 * @param {object} [jitoOptions] - Options (ignored)
 * @throws {Error} Always throws deprecation error
 */
async function pollBundleStatus(bundleId, jitoOptions = {}) {
    console.error(`[JitoService] ❌ pollBundleStatus is DEPRECATED and disabled to prevent Jito rate limiting`);
    console.error(`[JitoService] Use waitForBundleViaWebSocket(connection, firstSignature) instead`);
    console.error(`[JitoService] WebSocket confirmation avoids rate limits and is more reliable`);

    throw new Error(
        'pollBundleStatus is deprecated to prevent Jito rate limiting. ' +
        'Use waitForBundleViaWebSocket(connection, firstSignature) for bundle confirmation. ' +
        'This approach uses Solana WebSocket notifications instead of polling Jito endpoints.'
    );
}

/**
 * Endpoint rotation logic with rate limit handling for services
 * @param {string[]} encodedSignedTxs - Array of encoded signed transactions
 * @param {number} [maxRetries=3] - Maximum retry attempts
 * @param {number} [delayMs=1500] - Delay between endpoint rotations
 * @returns {Promise<string>} Bundle ID
 */
async function sendJitoBundleWithEndpointRotation(encodedSignedTxs, maxRetries = 3, delayMs = 1500) {
    let currentEndpointIndex = 0;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const jitoEndpoint = JITO_ENDPOINTS[currentEndpointIndex];
        console.log(`[JitoService] Attempt ${attempt}/${maxRetries} using endpoint: ${jitoEndpoint}`);

        try {
            const bundleId = await sendJitoBundleWithRetries(encodedSignedTxs, { jitoEndpoint });
            console.log(`[JitoService] Bundle sent successfully with ID: ${bundleId}`);
            return bundleId;
        } catch (error) {
            if (error.message === 'JITO_RATE_LIMITED' && attempt < maxRetries) {
                console.log(`[JitoService] ⚠️ Rate limited on ${jitoEndpoint}, rotating to next endpoint...`);
                currentEndpointIndex = (currentEndpointIndex + 1) % JITO_ENDPOINTS.length;
                await sleep(delayMs);
                continue;
            } else {
                throw error; // Rethrow on non-rate-limit error or final attempt
            }
        }
    }
}

module.exports = {
    // Core Jito functions
    sendJitoBundleWithRetries,
    confirmBundleWebSocketOnly,
    waitForBundleViaWebSocket,
    sendJitoBundleWithEndpointRotation,
    
    // Constants
    JITO_ENDPOINTS,
    JITO_REGIONAL_ENDPOINT,
    MAX_RETRIES_JITO_SEND,
    INITIAL_RETRY_DELAY_JITO_SEND,
    MAX_RETRY_DELAY_JITO_SEND,
    BUNDLE_STATUS_POLL_INTERVAL,
    BUNDLE_STATUS_POLL_ATTEMPTS,
    
    // Deprecated functions (for error handling)
    pollBundleStatus
};

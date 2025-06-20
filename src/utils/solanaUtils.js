const web3 = require('@solana/web3.js');
const { getSolanaConnection } = require('./walletUtils');
const { rateLimitedRpcCall, getRpcConfig } = require('./transactionUtils');

/**
 * Enhanced Solana Utilities for SPL Token Operations
 * 
 * MONOCODE Compliance:
 * - Observable Implementation: Structured logging with [SolanaUtils] prefix
 * - Explicit Error Handling: Comprehensive error context and graceful fallbacks
 * - Progressive Construction: Built upon existing RPC management infrastructure
 * - Dependency Transparency: Integrates with transactionUtils.js RPC config
 */

/**
 * Sleep utility function
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Enhanced retry function with exponential backoff integrated with RPC configuration
 * @param {Function} fn - The function to retry
 * @param {number} [maxRetries=3] - Maximum number of retry attempts
 * @param {number} [initialDelay] - Initial delay in milliseconds (auto-configured based on RPC)
 * @returns {Promise<any>} The result of the successful function call
 * @throws {Error} The last error encountered if all retries fail
 */
async function retryWithRpcConfig(fn, maxRetries = 3, initialDelay = null) {
    const rpcConfig = getRpcConfig();
    const baseDelay = initialDelay || rpcConfig.retryBackoff || 1000;
    let lastError;
    
    console.log(`[SolanaUtils] Starting retry operation with RPC config: ${rpcConfig.name}`);
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            
            if (i < maxRetries - 1) {
                const waitTime = baseDelay * Math.pow(2, i);
                console.log(`[SolanaUtils] Attempt ${i + 1}/${maxRetries} failed: ${error.message}. Retrying in ${waitTime}ms...`);
                await sleep(waitTime);
            }
        }
    }
    
    console.error(`[SolanaUtils] ❌ All ${maxRetries} retry attempts failed. Final error: ${lastError.message}`);
    throw lastError;
}

/**
 * Gets SPL token balance for a specific mint with enhanced error handling and rate limiting
 * @param {string} walletPublicKey - The wallet's public key as string
 * @param {string} mintAddress - The token mint address as string
 * @param {web3.Connection} [connectionOverride] - Optional connection override
 * @returns {Promise<{balance: number, decimals: number, mint: string}>} Token balance info
 */
async function getTokenBalance(walletPublicKey, mintAddress, connectionOverride = null) {
    console.log(`[SolanaUtils] Getting token balance for mint: ${mintAddress.slice(0, 8)}... wallet: ${walletPublicKey.slice(0, 8)}...`);
    
    try {
        // Validate inputs
        if (!walletPublicKey || !mintAddress) {
            throw new Error('Both walletPublicKey and mintAddress are required');
        }
        
        let walletPubKey, mintPubKey;
        try {
            walletPubKey = new web3.PublicKey(walletPublicKey);
            mintPubKey = new web3.PublicKey(mintAddress);
        } catch (error) {
            throw new Error(`Invalid public key format: ${error.message}`);
        }
        
        const connection = connectionOverride || getSolanaConnection();
        
        const result = await retryWithRpcConfig(async () => {
            return await rateLimitedRpcCall(async () => {
                return await connection.getParsedTokenAccountsByOwner(
                    walletPubKey,
                    { mint: mintPubKey }
                );
            });
        });

        if (!result.value || result.value.length === 0) {
            console.log(`[SolanaUtils] No token account found for mint ${mintAddress.slice(0, 8)}... - returning zero balance`);
            return { balance: 0, decimals: 0, mint: mintAddress };
        }

        const account = result.value[0];
        const tokenInfo = account.account.data.parsed.info.tokenAmount;
        const balance = Number(tokenInfo.amount);
        const decimals = tokenInfo.decimals;

        console.log(`[SolanaUtils] ✅ Token balance: ${balance} (${balance / Math.pow(10, decimals)} UI units, decimals: ${decimals})`);
        return { balance, decimals, mint: mintAddress };
        
    } catch (error) {
        console.error(`[SolanaUtils] ❌ Error getting token balance: ${error.message}`);
        // Graceful fallback following MONOCODE Explicit Error Handling
        return { balance: 0, decimals: 0, mint: mintAddress, error: error.message };
    }
}

/**
 * Gets all SPL token balances for a wallet
 * @param {string} walletPublicKey - The wallet's public key as string
 * @param {web3.Connection} [connectionOverride] - Optional connection override
 * @returns {Promise<Array<{balance: number, decimals: number, mint: string, symbol?: string}>>} Array of token balances
 */
async function getAllTokenBalances(walletPublicKey, connectionOverride = null) {
    console.log(`[SolanaUtils] Getting all token balances for wallet: ${walletPublicKey.slice(0, 8)}...`);
    
    try {
        // Validate input
        if (!walletPublicKey) {
            throw new Error('walletPublicKey is required');
        }
        
        let walletPubKey;
        try {
            walletPubKey = new web3.PublicKey(walletPublicKey);
        } catch (error) {
            throw new Error(`Invalid wallet public key format: ${error.message}`);
        }
        
        const connection = connectionOverride || getSolanaConnection();
        
        const result = await retryWithRpcConfig(async () => {
            return await rateLimitedRpcCall(async () => {
                return await connection.getParsedTokenAccountsByOwner(
                    walletPubKey,
                    { programId: new web3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') } // SPL Token Program
                );
            });
        });

        if (!result.value || result.value.length === 0) {
            console.log(`[SolanaUtils] No token accounts found for wallet ${walletPublicKey.slice(0, 8)}...`);
            return [];
        }

        const tokenBalances = result.value
            .map(account => {
                const tokenInfo = account.account.data.parsed.info;
                const balance = Number(tokenInfo.tokenAmount.amount);
                const decimals = tokenInfo.tokenAmount.decimals;
                const mint = tokenInfo.mint;
                
                // Only return tokens with non-zero balance
                if (balance > 0) {
                    return { balance, decimals, mint };
                }
                return null;
            })
            .filter(token => token !== null);

        console.log(`[SolanaUtils] ✅ Found ${tokenBalances.length} token accounts with balances`);
        return tokenBalances;
        
    } catch (error) {
        console.error(`[SolanaUtils] ❌ Error getting all token balances: ${error.message}`);
        // Graceful fallback
        return [];
    }
}

/**
 * Gets complete wallet summary (SOL + all SPL tokens)
 * @param {string} walletPublicKey - The wallet's public key as string
 * @param {web3.Connection} [connectionOverride] - Optional connection override
 * @returns {Promise<{sol: {balance: number, lamports: number}, tokens: Array, timestamp: string}>} Complete wallet summary
 */
async function getWalletSummary(walletPublicKey, connectionOverride = null) {
    console.log(`[SolanaUtils] Getting complete wallet summary for: ${walletPublicKey.slice(0, 8)}...`);
    
    try {
        // Validate input
        if (!walletPublicKey) {
            throw new Error('walletPublicKey is required');
        }
        
        let walletPubKey;
        try {
            walletPubKey = new web3.PublicKey(walletPublicKey);
        } catch (error) {
            throw new Error(`Invalid wallet public key format: ${error.message}`);
        }
        
        const connection = connectionOverride || getSolanaConnection();
        
        // Get SOL balance using existing walletUtils function
        const { getWalletBalance } = require('./walletUtils');
        
        const [solBalance, tokenBalances] = await Promise.all([
            retryWithRpcConfig(() => getWalletBalance(connection, walletPubKey)),
            getAllTokenBalances(walletPublicKey, connection)
        ]);
        
        // Handle case where SOL balance query failed
        const solBalanceResult = solBalance === -1 ? 0 : solBalance;
        const lamports = Math.floor(solBalanceResult * web3.LAMPORTS_PER_SOL);
        
        const summary = {
            sol: {
                balance: solBalanceResult,
                lamports: lamports
            },
            tokens: tokenBalances,
            timestamp: new Date().toISOString(),
            publicKey: walletPublicKey
        };
        
        console.log(`[SolanaUtils] ✅ Wallet summary complete: ${solBalanceResult} SOL, ${tokenBalances.length} tokens`);
        return summary;
        
    } catch (error) {
        console.error(`[SolanaUtils] ❌ Error getting wallet summary: ${error.message}`);
        // Graceful fallback with minimal data
        return {
            sol: { balance: 0, lamports: 0 },
            tokens: [],
            timestamp: new Date().toISOString(),
            publicKey: walletPublicKey,
            error: error.message
        };
    }
}

/**
 * Gets formatted token balance (converts raw balance to UI amount)
 * @param {string} walletPublicKey - The wallet's public key as string
 * @param {string} mintAddress - The token mint address as string
 * @param {web3.Connection} [connectionOverride] - Optional connection override
 * @returns {Promise<{uiAmount: number, rawBalance: number, decimals: number, mint: string}>} Formatted token balance
 */
async function getFormattedTokenBalance(walletPublicKey, mintAddress, connectionOverride = null) {
    console.log(`[SolanaUtils] Getting formatted token balance for mint: ${mintAddress.slice(0, 8)}...`);
    
    try {
        const tokenInfo = await getTokenBalance(walletPublicKey, mintAddress, connectionOverride);
        
        if (tokenInfo.error) {
            return { ...tokenInfo, uiAmount: 0, rawBalance: 0 };
        }
        
        const uiAmount = tokenInfo.balance / Math.pow(10, tokenInfo.decimals);
        
        const result = {
            uiAmount: uiAmount,
            rawBalance: tokenInfo.balance,
            decimals: tokenInfo.decimals,
            mint: tokenInfo.mint
        };
        
        console.log(`[SolanaUtils] ✅ Formatted balance: ${uiAmount} UI units (${tokenInfo.balance} raw)`);
        return result;
        
    } catch (error) {
        console.error(`[SolanaUtils] ❌ Error getting formatted token balance: ${error.message}`);
        return {
            uiAmount: 0,
            rawBalance: 0,
            decimals: 0,
            mint: mintAddress,
            error: error.message
        };
    }
}

/**
 * Checks if a wallet has any SPL tokens
 * @param {string} walletPublicKey - The wallet's public key as string
 * @param {web3.Connection} [connectionOverride] - Optional connection override
 * @returns {Promise<{hasTokens: boolean, tokenCount: number}>} Token existence info
 */
async function hasTokens(walletPublicKey, connectionOverride = null) {
    console.log(`[SolanaUtils] Checking if wallet has tokens: ${walletPublicKey.slice(0, 8)}...`);
    
    try {
        const tokens = await getAllTokenBalances(walletPublicKey, connectionOverride);
        const hasTokens = tokens.length > 0;
        
        console.log(`[SolanaUtils] ✅ Wallet ${hasTokens ? 'has' : 'has no'} tokens (${tokens.length} found)`);
        return { hasTokens, tokenCount: tokens.length };
        
    } catch (error) {
        console.error(`[SolanaUtils] ❌ Error checking for tokens: ${error.message}`);
        return { hasTokens: false, tokenCount: 0, error: error.message };
    }
}

module.exports = {
    // Core SPL token functions
    getTokenBalance,
    getAllTokenBalances,
    getWalletSummary,
    getFormattedTokenBalance,
    hasTokens,
    
    // Utility functions
    sleep,
    retryWithRpcConfig,
    
    // Legacy compatibility (if needed)
    delay: sleep
}; 
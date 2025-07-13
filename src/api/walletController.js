const walletService = require('../services/walletService');

async function createOrImportAirdropWallet(req, res) {
    try {
        // MONOCODE Fix: Support both field names for compatibility and match API.MD documentation
        const { privateKey, privateKeyBs58 } = req.body; 
        const privateKeyParam = privateKey || privateKeyBs58; // Prioritize 'privateKey' as per API.MD
        
        console.log(`[WalletController] Airdrop wallet request: ${privateKeyParam ? 'IMPORT' : 'CREATE'}`);
        
        const walletDetails = await walletService.createOrImportMotherWalletService(privateKeyParam);
        res.status(200).json({ message: 'Airdrop wallet processed successfully.', data: walletDetails });
    } catch (error) {
        console.error('[APIError] /api/wallets/airdrop:', error.message);
        res.status(500).json({ message: 'Error processing airdrop wallet.', error: error.message });
    }
}

async function createBundledWallets(req, res) {
    try {
        const { count, devWalletName, firstBundledWalletBaseName } = req.body;
        if (typeof count !== 'number' || count < 1) {
            return res.status(400).json({ message: 'Invalid input: count must be a number greater than 0.' });
        }
        const walletsDetails = await walletService.createBundledWalletsService(count, devWalletName, firstBundledWalletBaseName);
        res.status(200).json({ message: `${walletsDetails.length} bundled wallets created successfully.`, data: walletsDetails });
    } catch (error) {
        console.error('[APIError] /api/wallets/bundled (create):', error.message);
        res.status(500).json({ message: 'Error creating bundled wallets.', error: error.message });
    }
}

async function importBundledWallets(req, res) {
    try {
        const { wallets } = req.body; // Expects an array like [{name, privateKeyBs58}]
        if (!Array.isArray(wallets) || wallets.length === 0) {
            return res.status(400).json({ message: 'Invalid input: wallets must be a non-empty array.' });
        }
        const walletsDetails = await walletService.importBundledWalletsService(wallets);
        res.status(200).json({ message: `${walletsDetails.length} bundled wallets imported successfully.`, data: walletsDetails });
    } catch (error) {
        console.error('[APIError] /api/wallets/bundled (import):', error.message);
        res.status(500).json({ message: 'Error importing bundled wallets.', error: error.message });
    }
}

async function getWalletBalance(req, res) {
    try {
        const { publicKey } = req.params;
        if (!publicKey) {
            return res.status(400).json({ message: 'Public key parameter is required.'});
        }
        const balanceData = await walletService.getWalletBalanceService(publicKey);
        res.status(200).json({ message: 'Balance retrieved successfully.', data: balanceData });
    } catch (error) {
        console.error(`[APIError] /api/wallets/:publicKey/balance: ${publicKey}`, error.message);
        res.status(500).json({ message: 'Error retrieving wallet balance.', error: error.message });
    }
}

// ============================================================================
// PHASE 3: ENHANCED BALANCE API ENDPOINTS - OPTION B
// ============================================================================

/**
 * Gets SOL balance only (maintains backward compatibility).
 * Endpoint: GET /api/wallets/:publicKey/balance/sol
 * MONOCODE Compliance: Explicit error handling with structured responses
 */
async function getWalletBalanceSOL(req, res) {
    try {
        const { publicKey } = req.params;
        if (!publicKey) {
            return res.status(400).json({ 
                message: 'Public key parameter is required.',
                error: 'MISSING_PUBLIC_KEY'
            });
        }
        
        console.log(`[WalletController] Getting SOL balance for: ${publicKey.slice(0, 8)}...`);
        const balanceData = await walletService.getWalletBalanceService(publicKey);
        
        // Enhanced response format for consistency
        const response = {
            message: 'SOL balance retrieved successfully.',
            data: {
                publicKey: publicKey,
                sol: {
                    balance: balanceData.balance,
                    lamports: Math.floor(balanceData.balance * 1000000000),
                    usdValue: null // Placeholder for future price integration
                },
                timestamp: new Date().toISOString(),
                endpoint: 'sol'
            }
        };
        
        res.status(200).json(response);
    } catch (error) {
        console.error(`[APIError] /api/wallets/:publicKey/balance/sol: ${req.params.publicKey}`, error.message);
        res.status(500).json({ 
            message: 'Error retrieving SOL balance.',
            error: error.message,
            endpoint: 'sol'
        });
    }
}

/**
 * Gets balance for a specific SPL token.
 * Endpoint: GET /api/wallets/:publicKey/balance/token/:mintAddress
 * MONOCODE Compliance: Progressive construction with comprehensive validation
 */
async function getTokenBalance(req, res) {
    try {
        const { publicKey, mintAddress } = req.params;
        
        // Input validation
        if (!publicKey) {
            return res.status(400).json({ 
                message: 'Public key parameter is required.',
                error: 'MISSING_PUBLIC_KEY',
                endpoint: 'token'
            });
        }
        
        if (!mintAddress) {
            return res.status(400).json({ 
                message: 'Mint address parameter is required.',
                error: 'MISSING_MINT_ADDRESS',
                endpoint: 'token'
            });
        }
        
        console.log(`[WalletController] Getting token balance for mint: ${mintAddress.slice(0, 8)}... wallet: ${publicKey.slice(0, 8)}...`);
        const tokenData = await walletService.getTokenBalanceService(publicKey, mintAddress);
        
        // Enhanced response format
        const response = {
            message: tokenData.status === 'success' ? 
                'Token balance retrieved successfully.' : 
                'Token balance retrieved with warnings.',
            data: {
                publicKey: publicKey,
                token: {
                    mint: mintAddress,
                    balance: tokenData.balance,
                    decimals: tokenData.decimals,
                    uiAmount: tokenData.uiAmount,
                    symbol: null, // Placeholder for future symbol lookup
                    usdValue: null // Placeholder for future price integration
                },
                metadata: {
                    status: tokenData.status,
                    timestamp: tokenData.timestamp,
                    warning: tokenData.warning || null
                },
                endpoint: 'token'
            }
        };
        
        // Set appropriate status code based on result
        const statusCode = tokenData.status === 'error' ? 404 : 200;
        res.status(statusCode).json(response);
        
    } catch (error) {
        console.error(`[APIError] /api/wallets/:publicKey/balance/token/:mintAddress: ${req.params.publicKey}/${req.params.mintAddress}`, error.message);
        res.status(500).json({ 
            message: 'Error retrieving token balance.',
            error: error.message,
            endpoint: 'token'
        });
    }
}

/**
 * Gets complete wallet summary including SOL and all SPL tokens.
 * Endpoint: GET /api/wallets/:publicKey/balance/all
 * MONOCODE Compliance: Observable implementation with performance tracking
 */
async function getWalletBalanceAll(req, res) {
    try {
        const { publicKey } = req.params;
        const startTime = Date.now();
        
        if (!publicKey) {
            return res.status(400).json({ 
                message: 'Public key parameter is required.',
                error: 'MISSING_PUBLIC_KEY',
                endpoint: 'all'
            });
        }
        
        console.log(`[WalletController] Getting complete wallet summary for: ${publicKey.slice(0, 8)}...`);
        const summaryData = await walletService.getWalletSummaryService(publicKey);
        
        // Enhanced response format with comprehensive data
        const duration = Date.now() - startTime;
        const response = {
            message: summaryData.status === 'success' ? 
                'Complete wallet balance retrieved successfully.' : 
                'Wallet balance retrieved with warnings.',
            data: {
                publicKey: publicKey,
                sol: summaryData.sol,
                tokens: summaryData.tokens,
                summary: {
                    ...summaryData.summary,
                    performance: {
                        apiResponseTime: duration,
                        serviceResponseTime: summaryData.performance.queryDuration
                    }
                },
                metadata: {
                    status: summaryData.status,
                    timestamp: new Date().toISOString(),
                    warning: summaryData.warning || null,
                    lastUpdated: summaryData.summary.lastUpdated
                },
                endpoint: 'all'
            }
        };
        
        console.log(`[WalletController] ✅ Complete summary: ${summaryData.sol.balance} SOL, ${summaryData.tokens.length} tokens in ${duration}ms`);
        
        // Set appropriate status code based on result
        const statusCode = summaryData.status === 'error' ? 404 : 200;
        res.status(statusCode).json(response);
        
    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`[APIError] /api/wallets/:publicKey/balance/all: ${req.params.publicKey}`, error.message);
        res.status(500).json({ 
            message: 'Error retrieving complete wallet balance.',
            error: error.message,
            performance: {
                apiResponseTime: duration
            },
            endpoint: 'all'
        });
    }
}

/**
 * Gets all SPL token balances (without SOL).
 * Endpoint: GET /api/wallets/:publicKey/balance/tokens
 * MONOCODE Compliance: Dependency transparency with clear separation
 */
async function getAllTokenBalances(req, res) {
    try {
        const { publicKey } = req.params;
        const startTime = Date.now();
        
        if (!publicKey) {
            return res.status(400).json({ 
                message: 'Public key parameter is required.',
                error: 'MISSING_PUBLIC_KEY',
                endpoint: 'tokens'
            });
        }
        
        console.log(`[WalletController] Getting all token balances for: ${publicKey.slice(0, 8)}...`);
        const tokensData = await walletService.getAllTokenBalancesService(publicKey);
        
        // Enhanced response format
        const duration = Date.now() - startTime;
        const response = {
            message: tokensData.status === 'success' ? 
                'All token balances retrieved successfully.' : 
                'Token balances retrieved with warnings.',
            data: {
                publicKey: publicKey,
                tokens: tokensData.tokens,
                summary: {
                    ...tokensData.summary,
                    performance: {
                        apiResponseTime: duration,
                        serviceResponseTime: tokensData.performance.queryDuration
                    }
                },
                metadata: {
                    status: tokensData.status,
                    timestamp: new Date().toISOString(),
                    warning: tokensData.error || null
                },
                endpoint: 'tokens'
            }
        };
        
        console.log(`[WalletController] ✅ All tokens: ${tokensData.tokens.length} tokens in ${duration}ms`);
        
        // Set appropriate status code based on result
        const statusCode = tokensData.status === 'error' ? 404 : 200;
        res.status(statusCode).json(response);
        
    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`[APIError] /api/wallets/:publicKey/balance/tokens: ${req.params.publicKey}`, error.message);
        res.status(500).json({ 
            message: 'Error retrieving token balances.',
            error: error.message,
            performance: {
                apiResponseTime: duration
            },
            endpoint: 'tokens'
        });
    }
}

async function fundBundledWallets(req, res) {
    try {
        const { amountPerWalletSOL, childWallets, motherWalletPrivateKeyBs58, targetWalletNames } = req.body;
        
        // Validation
        if (typeof amountPerWalletSOL !== 'number' || amountPerWalletSOL <= 0) {
            return res.status(400).json({ message: 'Invalid input: amountPerWalletSOL must be a positive number.' });
        }
        if (!childWallets || !Array.isArray(childWallets) || childWallets.length === 0) {
            return res.status(400).json({ message: 'Invalid input: childWallets must be a non-empty array of wallet objects.' });
        }
        if (!motherWalletPrivateKeyBs58) {
            return res.status(400).json({ message: 'Invalid input: motherWalletPrivateKeyBs58 is required for stateless funding operation.' });
        }
        
        console.log(`[WalletController] Funding ${childWallets.length} child wallets with ${amountPerWalletSOL} SOL each`);
        
        // Call service with updated signature
        const results = await walletService.fundChildWalletsService(amountPerWalletSOL, childWallets, motherWalletPrivateKeyBs58, targetWalletNames);
        res.status(200).json({ message: 'Funding process completed.', data: results });
    } catch (error) {
        console.error('[APIError] /api/wallets/fund-bundled:', error.message);
        res.status(500).json({ message: 'Error funding bundled wallets.', error: error.message });
    }
}

async function returnFundsToMother(req, res) {
    try {
        const { childWallets, motherWalletPublicKeyBs58, sourceWalletNames } = req.body;
        
        // Validation
        if (!childWallets || !Array.isArray(childWallets) || childWallets.length === 0) {
            return res.status(400).json({ message: 'Invalid input: childWallets must be a non-empty array of wallet objects.' });
        }
        if (!motherWalletPublicKeyBs58) {
            return res.status(400).json({ message: 'Invalid input: motherWalletPublicKeyBs58 is required.' });
        }
        
        console.log(`[WalletController] Returning funds from ${childWallets.length} child wallets to mother wallet`);
        
        // Call service with updated signature  
        const results = await walletService.returnFundsToMotherWalletService(childWallets, motherWalletPublicKeyBs58, sourceWalletNames);
        res.status(200).json({ message: 'Return funds process completed.', data: results });
    } catch (error) {
        console.error('[APIError] /api/wallets/return-funds:', error.message);
        res.status(500).json({ message: 'Error returning funds to mother wallet.', error: error.message });
    }
}

module.exports = {
    // Existing controllers (backward compatibility maintained)
    createOrImportAirdropWallet,
    createBundledWallets,
    importBundledWallets,
    getWalletBalance, // Original balance endpoint - maintains existing functionality
    fundBundledWallets,
    returnFundsToMother,
    
    // PHASE 3: Enhanced Balance API Controllers - Option B
    getWalletBalanceSOL,      // GET /api/wallets/:publicKey/balance/sol
    getTokenBalance,          // GET /api/wallets/:publicKey/balance/token/:mintAddress
    getWalletBalanceAll,      // GET /api/wallets/:publicKey/balance/all
    getAllTokenBalances       // GET /api/wallets/:publicKey/balance/tokens
}; 
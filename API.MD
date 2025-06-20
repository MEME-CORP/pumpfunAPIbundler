# PumpFun API Bundler – General API Documentation

## Overview

This API provides endpoints for managing Solana wallets and interacting with the Pump.fun platform, including token creation, batch buying, and batch selling using Jito bundles. It is built with Node.js, Express, and Solana's `@solana/web3.js` library, and follows best practices for transaction reliability and security.

---

## Core Endpoints

### **Wallet Management**

#### 1. Create or Import Airdrop (Mother) Wallet
- **POST** `/api/wallets/airdrop`
- **Body:** `{ "privateKey": "<base58 string>" }` (optional, for import)
- **Response:** Public key, private key (if new), status message.

#### 2. Create Bundled (Child) Wallets
- **POST** `/api/wallets/bundled/create`
- **Body:** `{ "count": <number> }`
- **Response:** List of created wallets, with one named "DevWallet" and the next four as "First Bundled Wallet 1-4".

#### 3. Import Bundled (Child) Wallets
- **POST** `/api/wallets/bundled/import`
- **Body:** `{ "wallets": [ { "name": "...", "privateKey": "<base58>" }, ... ] }`
- **Response:** List of imported wallets.

#### 4. Fund Bundled Wallets
- **POST** `/api/wallets/fund-bundled`
- **Body:** `{ "amountPerWallet": <number> }`
- **Response:** Transaction results for each wallet.

#### 5. Return Funds to Mother Wallet
- **POST** `/api/wallets/return-funds`
- **Body:** `{ "leaveDust": <boolean> }`
- **Response:** Transaction results for each wallet.

#### 6. Get Wallet Balance (Enhanced SPL Token Support)

##### 6.1 SOL Balance Only
- **GET** `/api/wallets/:publicKey/balance/sol`
- **Response:** 
  ```json
  {
    "message": "SOL balance retrieved successfully.",
    "data": {
      "publicKey": "wallet_address",
      "sol": {
        "balance": 1.5,
        "lamports": 1500000000,
        "usdValue": null
      },
      "timestamp": "2024-01-01T00:00:00Z",
      "endpoint": "sol"
    }
  }
  ```

##### 6.2 Specific SPL Token Balance
- **GET** `/api/wallets/:publicKey/balance/token/:mintAddress`
- **Response:**
  ```json
  {
    "message": "Token balance retrieved successfully.",
    "data": {
      "publicKey": "wallet_address",
      "token": {
        "mint": "token_mint_address",
        "balance": 1000000,
        "decimals": 6,
        "uiAmount": 1.0,
        "symbol": null,
        "usdValue": null
      },
      "metadata": {
        "status": "success",
        "timestamp": "2024-01-01T00:00:00Z"
      },
      "endpoint": "token"
    }
  }
  ```

##### 6.3 Complete Wallet Summary (SOL + All SPL Tokens)
- **GET** `/api/wallets/:publicKey/balance/all`
- **Response:**
  ```json
  {
    "message": "Complete wallet balance retrieved successfully.",
    "data": {
      "publicKey": "wallet_address",
      "sol": {
        "balance": 1.5,
        "lamports": 1500000000,
        "usdValue": null
      },
      "tokens": [
        {
          "mint": "token_mint_address",
          "balance": 1000000,
          "decimals": 6,
          "uiAmount": 1.0,
          "symbol": null,
          "usdValue": null
        }
      ],
      "summary": {
        "totalAssets": 2,
        "solBalance": 1.5,
        "tokenCount": 1,
        "hasTokens": true,
        "lastUpdated": "2024-01-01T00:00:00Z",
        "performance": {
          "apiResponseTime": 1500,
          "serviceResponseTime": 1200
        }
      },
      "metadata": {
        "status": "success",
        "timestamp": "2024-01-01T00:00:00Z"
      },
      "endpoint": "all"
    }
  }
  ```

##### 6.4 All SPL Tokens Only (Without SOL)
- **GET** `/api/wallets/:publicKey/balance/tokens`
- **Response:**
  ```json
  {
    "message": "All token balances retrieved successfully.",
    "data": {
      "publicKey": "wallet_address",
      "tokens": [
        {
          "mint": "token_mint_address",
          "balance": 1000000,
          "decimals": 6,
          "uiAmount": 1.0
        }
      ],
      "summary": {
        "tokenCount": 1,
        "hasTokens": true,
        "totalTokenAccounts": 1,
        "performance": {
          "apiResponseTime": 800,
          "serviceResponseTime": 600
        }
      },
      "metadata": {
        "status": "success",
        "timestamp": "2024-01-01T00:00:00Z"
      },
      "endpoint": "tokens"
    }
  }
  ```

##### 6.5 Legacy Endpoint (Backward Compatibility)
- **GET** `/api/wallets/:publicKey/balance`
- **Response:** `{ "message": "Balance retrieved successfully.", "data": { "publicKey": "...", "balance": 1.5 } }`
- **Note:** This endpoint maintains backward compatibility and returns SOL balance only.

---

### **Pump Portal Trading**

#### 1. Create Token and Initial Buy
- **POST** `/api/pump/create-and-buy`
- **Body:** 
  ```json
  {
    "name": "...",
    "symbol": "...",
    "description": "...",
    "twitter": "...",
    "telegram": "...",
    "website": "...",
    "showName": true,
    "initialSupplyAmount": "1000000000",
    "imageFileName": "...",
    "buyAmountsSOL": {
      "devWalletBuySOL": 0.01,
      "firstBundledWallet1BuySOL": 0.01,
      ...
    },
    "slippageBps": 2500
  }
  ```
- **Response:** Mint address, bundle ID, transaction details, status.

#### 2. Batch Buy Token
- **POST** `/api/pump/batch-buy`
- **Body:** 
  ```json
  {
    "mintAddress": "...",
    "solAmountPerWallet": 0.01,
    "slippageBps": 2500,
    "targetWalletNames": ["Bundled Wallet 5", ...] // optional
  }
  ```
- **Response:** Bundle results, transaction details, status.

#### 3. DevWallet Sell
- **POST** `/api/pump/sell-dev`
- **Body:** 
  ```json
  {
    "mintAddress": "...",
    "sellAmountPercentage": "50%", // or 50
    "slippageBps": 2500
  }
  ```
- **Response:** Bundle ID, transaction details, status.

#### 4. Batch Sell (All Non-DevWallets)
- **POST** `/api/pump/batch-sell`
- **Body:** 
  ```json
  {
    "mintAddress": "...",
    "sellAmountPercentage": "100%", // or 100
    "slippageBps": 2500,
    "targetWalletNames": ["Bundled Wallet 5", ...] // optional
  }
  ```
- **Response:** Bundle results, transaction details, status.

---

## General Notes

- All endpoints return JSON.
- All endpoints perform input validation and return clear error messages on invalid input.
- All trading endpoints use robust transaction handling, Jito bundles, and follow Solana best practices for reliability.
- Private keys are never returned by trading endpoints.
- All transaction results include bundle IDs and transaction signatures for on-chain verification.

---

# API Testing Checklist

## General

- **API server starts without errors.**
- **All endpoints are accessible and respond to valid requests.**
- **Invalid requests (missing/invalid parameters) return clear error messages.**
- **No sensitive information (private keys) is leaked in responses.**

## Wallet Management

- **Airdrop wallet can be created and imported.**
  - *Expected:* Returns public key, and private key if new.
- **Bundled wallets can be created and imported.**
  - *Expected:* Returns list of wallets, with correct naming.
- **Funding and returning funds works.**
  - *Expected:* SOL is transferred, balances update, transaction signatures are valid.
- **Enhanced wallet balance queries work for all endpoints.**
  - *Expected:* Returns correct SOL balance, SPL token balances, and complete wallet summaries.

## Enhanced Balance Endpoints Testing

- **SOL balance endpoint works correctly.**
  - *Test:* `GET /api/wallets/:publicKey/balance/sol`
  - *Expected:* Returns SOL balance with proper lamports conversion and metadata.
- **Specific token balance endpoint works correctly.**
  - *Test:* `GET /api/wallets/:publicKey/balance/token/:mintAddress`
  - *Expected:* Returns token balance with decimals, UI amount, and proper error handling for non-existent tokens.
- **Complete wallet summary endpoint works correctly.**
  - *Test:* `GET /api/wallets/:publicKey/balance/all`
  - *Expected:* Returns SOL + all SPL tokens with performance metrics and comprehensive metadata.
- **All tokens endpoint works correctly.**
  - *Test:* `GET /api/wallets/:publicKey/balance/tokens`
  - *Expected:* Returns all SPL tokens without SOL, includes token count and existence flags.
- **Legacy balance endpoint maintains backward compatibility.**
  - *Test:* `GET /api/wallets/:publicKey/balance`
  - *Expected:* Original SOL-only response format preserved, no breaking changes.

## Pump Portal Trading

- **Create-and-buy endpoint creates a token and performs initial buys.**
  - *Expected:* Returns mint address, bundle ID, all transactions confirmed, token visible on Solscan/pump.fun.
- **Batch-buy endpoint buys token from all eligible wallets in batches.**
  - *Expected:* All specified wallets buy the token, bundles are confirmed, balances update.
- **Sell-dev endpoint sells the specified percentage of tokens from DevWallet.**
  - *Expected:* DevWallet's token balance decreases, SOL balance increases, transaction confirmed.
- **Batch-sell endpoint sells the specified percentage of tokens from all non-DevWallets.**
  - *Expected:* All specified wallets sell tokens, bundles are confirmed, balances update.

## Error Handling

- **Invalid mint addresses, wallet names, or percentages are rejected with clear errors.**
- **Insufficient balances are detected and reported.**
- **Network or RPC errors are handled gracefully and reported.**

## On-Chain Verification

- **All transaction signatures and bundle IDs returned can be checked on Solscan and Jito Explorer.**
- **Token creation, buys, and sells are visible on-chain.**

---

# What Should Be Tested

- **All endpoints with valid and invalid input.**
- **Edge cases (e.g., 0%/100% sell, missing wallets, duplicate wallet names).**
- **Batching logic (correct number of transactions per bundle, correct tipper).**
- **Minimum SOL balance enforcement for tippers and non-tippers.**
- **Robustness under network/RPC errors (simulate failures if possible).**
- **Correctness of returned data (mint address, bundle IDs, transaction signatures).**
- **No sensitive data leakage.**

---

# Expected Results

- **All endpoints work as described above.**
- **All on-chain actions (token creation, buys, sells) are verifiable.**
- **API returns clear, consistent, and informative responses.**
- **No unhandled exceptions or server crashes.**
- **No private keys or sensitive data are leaked in any response.**

---

---

## Manual Testing Commands for Enhanced Balance Endpoints

### Testing SOL Balance
```bash
# Test SOL balance only
curl -X GET "http://localhost:3000/api/wallets/YOUR_WALLET_ADDRESS/balance/sol"

# Expected: SOL balance with lamports and metadata
```

### Testing Specific Token Balance
```bash
# Test USDC balance (example)
curl -X GET "http://localhost:3000/api/wallets/YOUR_WALLET_ADDRESS/balance/token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

# Test with non-existent token (error handling)
curl -X GET "http://localhost:3000/api/wallets/YOUR_WALLET_ADDRESS/balance/token/invalid_mint_address"

# Expected: Token balance with decimals, UI amount, or proper error response
```

### Testing Complete Wallet Summary
```bash
# Test complete wallet overview
curl -X GET "http://localhost:3000/api/wallets/YOUR_WALLET_ADDRESS/balance/all"

# Expected: SOL + all SPL tokens with performance metrics
```

### Testing All Tokens Only
```bash
# Test all SPL tokens without SOL
curl -X GET "http://localhost:3000/api/wallets/YOUR_WALLET_ADDRESS/balance/tokens"

# Expected: Array of all SPL tokens with summary metadata
```

### Testing Backward Compatibility
```bash
# Test legacy endpoint still works
curl -X GET "http://localhost:3000/api/wallets/YOUR_WALLET_ADDRESS/balance"

# Expected: Original SOL-only response format (backward compatible)
```

### Error Scenario Testing
```bash
# Test invalid wallet address
curl -X GET "http://localhost:3000/api/wallets/invalid_address/balance/sol"

# Test missing parameters
curl -X GET "http://localhost:3000/api/wallets//balance/token/MINT_ADDRESS"

# Expected: Proper HTTP status codes (400, 404, 500) and structured error responses
```

### Performance Testing Examples
```bash
# Test response times for different endpoints
time curl -X GET "http://localhost:3000/api/wallets/YOUR_WALLET_ADDRESS/balance/sol"
time curl -X GET "http://localhost:3000/api/wallets/YOUR_WALLET_ADDRESS/balance/all"

# Expected: SOL queries <5s, complete summaries <15s (may be slower with rate limiting)
```

---

**For further integration or automated testing, use tools like Postman, curl, or custom scripts to hit each endpoint with a variety of valid and invalid payloads, and verify both the API response and the on-chain results.**
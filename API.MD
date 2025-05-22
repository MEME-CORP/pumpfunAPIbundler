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

#### 6. Get Wallet Balance
- **GET** `/api/wallets/:publicKey/balance`
- **Response:** `{ "balance": <number> }`

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
- **Wallet balances can be queried.**
  - *Expected:* Returns correct SOL balance.

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

**For further integration or automated testing, use tools like Postman, curl, or custom scripts to hit each endpoint with a variety of valid and invalid payloads, and verify both the API response and the on-chain results.**
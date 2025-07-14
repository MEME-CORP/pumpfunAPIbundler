# PumpFun API Bundler – General API Documentation

## Overview

This API provides endpoints for managing Solana wallets and interacting with the Pump.fun platform, including token creation, batch buying, and batch selling using Jito bundles. It is built with Node.js, Express, and Solana's `@solana/web3.js` library, and follows best practices for transaction reliability and security.

**Key Features:**
- **Stateless Operation:** All wallet credentials are provided via API requests, not stored on server
- **Memory-based Image Processing:** Images are processed in RAM for maximum security and scalability
- **Jito Bundle Integration:** Optimized for MEV protection and transaction reliability
- **Render-Compatible:** Fully compatible with ephemeral container deployments
- **Flexible Field Names:** Supports both `privateKey` and `privateKeyBs58` for backward compatibility

---

## Core Endpoints

### **Wallet Management**

#### 1. Create or Import Airdrop (Mother) Wallet
- **POST** `/api/wallets/airdrop`
- **Body:** `{ "privateKey": "<base58 string>" }` (optional, for import)
- **Alternative Body:** `{ "privateKeyBs58": "<base58 string>" }` (optional, for import - legacy compatibility)
- **Response:** Public key, private key (as base58), wallet name, status message.
- **Note:** **Stateless Operation** - No data is stored on server. Wallets are created or imported and returned immediately.

#### 2. Create Bundled (Child) Wallets
- **POST** `/api/wallets/bundled/create`
- **Body:** `{ "count": <number> }`
- **Response:** List of created wallets, with one named "DevWallet" and the next four as "First Bundled Wallet 1-4".
- **Note:** **Stateless Operation** - Wallets are generated and returned immediately. No server-side storage.

#### 3. Import Bundled (Child) Wallets
- **POST** `/api/wallets/bundled/import`
- **Body:** `{ "wallets": [ { "name": "...", "privateKey": "<base58>" }, ... ] }`
- **Alternative Body:** `{ "wallets": [ { "name": "...", "privateKeyBs58": "<base58>" }, ... ] }`
- **Response:** List of imported wallets with names, public keys, and private keys.
- **Note:** **Stateless Operation** - Both `privateKey` and `privateKeyBs58` field names are accepted for flexibility. No server-side storage.

#### 4. Fund Bundled Wallets
- **POST** `/api/wallets/fund-bundled`
- **Body:** 
  ```json
  {
    "amountPerWalletSOL": <number>,
    "childWallets": [
      { "name": "DevWallet", "privateKey": "<base58 string>" },
      { "name": "First Bundled Wallet 1", "privateKey": "<base58 string>" }
    ],
    "motherWalletPrivateKeyBs58": "<base58 string>",
    "targetWalletNames": ["DevWallet"] // optional
  }
  ```
- **Response:** Transaction results for each wallet.
- **Note:** **Stateless Operation** - All wallet credentials must be provided in the request. Mother wallet must have sufficient balance to cover transfers plus rent exemption requirements for token operations.

#### 5. Return Funds to Mother Wallet
- **POST** `/api/wallets/return-funds`
- **Body:** 
  ```json
  {
    "childWallets": [
      { "name": "DevWallet", "privateKey": "<base58 string>" },
      { "name": "First Bundled Wallet 1", "privateKey": "<base58 string>" }
    ],
    "motherWalletPublicKeyBs58": "<base58 string>",
    "sourceWalletNames": ["DevWallet"] // optional
  }
  ```
- **Response:** Transaction results for each wallet.
- **Note:** **Stateless Operation** - All wallet credentials must be provided in the request. Automatically preserves rent exemption amounts (~0.00204 SOL) in each wallet for future token operations.

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

### **Trading**

#### **Image Upload Integration**

The API now supports secure image uploads for token creation using multipart/form-data uploads. Key features:

- **Memory-based Processing:** Images are processed in RAM and uploaded to Pinata IPFS
- **No Disk Storage:** Files are never saved to the server filesystem (stateless operation)
- **IPFS Integration:** Images and metadata are stored on IPFS via Pinata for decentralized access
- **Security:** File type validation, size limits (5MB), and comprehensive error handling
- **Render-Compatible:** Works perfectly with ephemeral containers and horizontal scaling

**Supported Image Formats:** PNG, JPG, JPEG, GIF, WebP, SVG  
**Maximum File Size:** 5MB  
**Upload Field Name:** `image`  
**Environment Variable Required:** `PINATA_JWT` must be set for IPFS uploads

#### 1. Create Token and Initial Buy
- **POST** `/api/pump/create-and-buy`
- **Content-Type:** `multipart/form-data`
- **Body Parameters:**
  - **Form Fields:**
    ```
    name: string (required)
    symbol: string (required)
    description: string (required)
    twitter: string (optional)
    telegram: string (optional)
    website: string (optional)
    showName: boolean (required)
    initialSupplyAmount: string (optional, default: "1000000000")
    buyAmountsSOL: JSON string (required) - Must be valid JSON format
    wallets: JSON string (required) - Array of wallet objects with name and privateKey
    slippageBps: number (optional, default: 2500)
    ```
  - **File Field:**
    ```
    image: file (optional) - Image file for the token (PNG, JPG, GIF, etc.)
    ```
- **Example cURL:**
  ```bash
  curl -X POST http://localhost:3000/api/pump/create-and-buy \
    -F "name=My Token" \
    -F "symbol=MTK" \
    -F "description=A great token" \
    -F "showName=true" \
    -F "buyAmountsSOL={\"devWalletBuySOL\":0.01,\"firstBundledWallet1BuySOL\":0.01}" \
    -F "wallets=[{\"name\":\"DevWallet\",\"privateKey\":\"base58_private_key_here\"},{\"name\":\"First Bundled Wallet 1\",\"privateKey\":\"base58_private_key_here\"}]" \
    -F "image=@/path/to/token-image.png"
  ```
- **Response:** Mint address, bundle ID, transaction details, status.
- **Important Notes:** 
  - Images are processed in memory and uploaded to Pinata IPFS for decentralized storage. No files are saved to disk.
  - **buyAmountsSOL must be a valid JSON string** when using multipart/form-data (not a JavaScript object).
  - **wallets must be a valid JSON string** containing an array of wallet objects with `name` and `privateKey` properties.
  - **Required Wallet Names:**
    - Must include `"DevWallet"` as the creator wallet
    - Buying wallets should be named `"First Bundled Wallet 1"`, `"First Bundled Wallet 2"`, etc.
    - Private keys must be base58 encoded Solana keypairs
  - **Minimum SOL Balance Requirements:**
    - DevWallet (tipper): Requires **0.055 SOL** minimum + buy amount
    - Other wallets: Require **0.025 SOL** minimum + buy amount
    - Example: For a 0.01 SOL buy, DevWallet needs 0.065 SOL total, other wallets need 0.035 SOL total

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
- **Minimum SOL Balance:** Each wallet needs **0.025 SOL** minimum + buy amount (tipper wallet needs 0.055 SOL minimum + buy amount)

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
- **Minimum SOL Balance:** DevWallet needs **0.055 SOL** minimum to cover transaction fees and Jito tips

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
- **Minimum SOL Balance:** Each wallet needs **0.025 SOL** minimum (tipper wallet needs 0.055 SOL minimum)

---

## General Notes

- All endpoints return JSON.
- All endpoints perform input validation and return clear error messages on invalid input.
- All trading endpoints use robust transaction handling, Jito bundles, and follow Solana best practices for reliability.
- Private keys are never returned by trading endpoints.
- All transaction results include bundle IDs and transaction signatures for on-chain verification.
- **Minimum SOL Balance Requirements:** All wallets must maintain minimum SOL balances to cover transaction fees, Jito tips, and rent exemption:
  - **DevWallet (tipper):** 0.055 SOL minimum + any buy/sell amounts + 0.00204 SOL rent exemption
  - **Other wallets:** 0.025 SOL minimum + any buy/sell amounts + 0.00204 SOL rent exemption
  - **Wallet Management Operations:** Automatically accounts for rent exemption requirements when funding/returning funds
  - **Enhanced Fee Calculation:** Uses precise priority fee calculation (base 5,000 + priority ~20,000 lamports = ~25,000 lamports total)
  - **Rent Exemption:** 0.00203928 SOL (2,039,280 lamports) for Associated Token Account (ATA) creation
  - **Automatic Rent Preservation:** Fund and return operations automatically preserve rent exemption amounts
  - **Insufficient Balance Detection:** Enhanced error handling detects "custom program error: 1", "Insufficient Funds For Rent", and other insufficient funds variations
  - Insufficient balance will result in transaction failure with clear error messages.

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
  - *Expected:* Proper fee calculation prevents insufficient funds errors.
  - *Expected:* Enhanced error detection provides clear feedback for balance issues.
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

## Trading

- **Create-and-buy endpoint creates a token and performs initial buys.**
  - *Expected:* Returns mint address, bundle ID, all transactions confirmed, token visible on Solscan/pump.fun.
- **Image upload functionality works correctly.**
  - *Test:* Send multipart/form-data with image file
  - *Expected:* Image is processed in memory, uploaded, and included in token metadata.
- **Fallback behavior works when no image is provided.**
  - *Test:* Send create-and-buy request without image field
  - *Expected:* Token is created successfully without image, metadata-only upload.
- **Image validation works correctly.**
  - *Test:* Upload invalid file types or oversized files
  - *Expected:* Clear error messages returned, request rejected before processing.
- **Batch-buy endpoint buys token from all eligible wallets in batches.**
  - *Expected:* All specified wallets buy the token, bundles are confirmed, balances update.
- **Sell-dev endpoint sells the specified percentage of tokens from DevWallet.**
  - *Expected:* DevWallet's token balance decreases, SOL balance increases, transaction confirmed.
- **Batch-sell endpoint sells the specified percentage of tokens from all non-DevWallets.**
  - *Expected:* All specified wallets sell tokens, bundles are confirmed, balances update.

## Error Handling

- **Invalid mint addresses, wallet names, or percentages are rejected with clear errors.**
- **Insufficient balances are detected and reported with enhanced error detection:**
  - Detects "custom program error: 1" (insufficient lamports)
  - Detects "insufficient funds" and "Insufficient funds" variations
  - Detects "insufficient lamports" errors
  - Detects "Insufficient Funds For Rent" errors (when wallet lacks rent exemption minimum)
  - Provides detailed logging for debugging
  - Validates balances before operations with rent exemption calculations
- **Network or RPC errors are handled gracefully and reported.**
- **Transaction fee calculation errors are prevented through accurate fee estimation.**

## On-Chain Verification

- **All transaction signatures and bundle IDs returned can be checked on Solscan and Jito Explorer.**
- **Token creation, buys, and sells are visible on-chain.**

---

# What Should Be Tested

- **All endpoints with valid and invalid input.**
- **Edge cases (e.g., 0%/100% sell, missing wallets, duplicate wallet names).**
- **Batching logic (correct number of transactions per bundle, correct tipper).**
- **Minimum SOL balance enforcement for tippers and non-tippers.**
- **Accurate transaction fee calculation and insufficient funds prevention.**
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
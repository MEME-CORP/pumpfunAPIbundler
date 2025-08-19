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
    createAmountSOL: number (optional, default: 0.001) - SOL amount for token creation
    buyAmountsSOL: JSON string (required) - Must be valid JSON format
    wallets: JSON string (required) - Array of wallet objects with name and privateKey
    slippageBps: number (optional, default: 2500)
    ```
  - **File Field:**
    ```
    image: file (optional) - Image file for the token (PNG, JPG, GIF, etc.)
    ```
- **Important Parameter Details:**
  - **createAmountSOL**: SOL amount for token creation (e.g., 0.001 for 0.001 SOL). This is the amount DevWallet spends to create the token.
  - **buyAmountsSOL**: Must be a JSON string with SOL amounts (e.g., `{"devWalletBuySOL":0.01,"firstBundledWallet1BuySOL":0.01}`)
  - **slippageBps**: Slippage in basis points (e.g., 2500 = 25%, 1000 = 10%). API converts to percentage format for pump.fun
  - **Priority fees**: Handled automatically by the API - no need to specify
- **Example cURL:**
  ```bash
  curl -X POST http://localhost:3000/api/pump/create-and-buy \
    -F "name=My Token" \
    -F "symbol=MTK" \
    -F "description=A great token" \
    -F "showName=true" \
    -F "createAmountSOL=0.001" \
    -F "slippageBps=2500" \
    -F "buyAmountsSOL={\"devWalletBuySOL\":0.01,\"firstBundledWallet1BuySOL\":0.01}" \
    -F "wallets=[{\"name\":\"DevWallet\",\"privateKey\":\"base58_private_key_here\"},{\"name\":\"First Bundled Wallet 1\",\"privateKey\":\"base58_private_key_here\"}]" \
    -F "image=@/path/to/token-image.png"
  ```
- **Response:** Mint address, bundle ID, transaction details, status.
- **Important Notes:** 
  - Images are processed in memory and uploaded to Pinata IPFS for decentralized storage. No files are saved to disk.
  - **buyAmountsSOL must be a valid JSON string** when using multipart/form-data (not a JavaScript object).
  - **wallets must be a valid JSON string** containing an array of wallet objects with `name` and `privateKey` properties.
  - Private keys must be base58 encoded Solana keypairs
  - **Minimum SOL Balance Requirements:**
    - DevWallet (tipper): Requires **0.055 SOL** minimum + create amount + buy amount
    - Other wallets: Require **0.025 SOL** minimum + buy amount
    - Example: For 0.001 SOL create + 0.01 SOL buy, DevWallet needs 0.066 SOL total, other wallets need 0.035 SOL total

#### **📋 How Create-and-Buy Works**

**The `/api/pump/create-and-buy` endpoint processes wallets dynamically based on the `buyAmountsSOL` object you provide.**

##### **Wallet Processing Logic:**
1. **DevWallet (Required)**: Must be named exactly `"DevWallet"` - this wallet creates the token and optionally buys
2. **Buying Wallets (Flexible)**: Any wallet can participate in buying if you include it in `buyAmountsSOL`

##### **buyAmountsSOL Key Matching:**
The service matches `buyAmountsSOL` keys to wallet names using flexible pattern matching:
- `"firstBundledWallet1BuySOL"` → matches wallet named `"First Bundled Wallet 1"`
- `"childWallet1BuySOL"` → matches wallet named `"Child Wallet 1"`
- `"myCustomWalletBuySOL"` → matches wallet named `"My Custom Wallet"`

##### **Example Request Structure:**
```json
{
  "buyAmountsSOL": {
    "devWalletBuySOL": 0.01,
    "firstBundledWallet1BuySOL": 0.005,
    "firstBundledWallet2BuySOL": 0.005,
    "childWallet1BuySOL": 0.003,
    "childWallet2BuySOL": 0.003
  },
  "wallets": [
    {"name": "DevWallet", "privateKey": "base58_key_here"},
    {"name": "First Bundled Wallet 1", "privateKey": "base58_key_here"},
    {"name": "First Bundled Wallet 2", "privateKey": "base58_key_here"},
    {"name": "Child Wallet 1", "privateKey": "base58_key_here"},
    {"name": "Child Wallet 2", "privateKey": "base58_key_here"}
  ]
}
```

##### **⚠️ Important Rules:**
- **DevWallet is mandatory** and must be named exactly `"DevWallet"`
- **Only wallets with corresponding `buyAmountsSOL` entries will participate in buying**
- **Wallets without buy amounts are ignored** (except DevWallet which always creates the token)
- **Wallet names are matched flexibly** - spaces and capitalization variations are handled automatically
- **All participating wallets must have sufficient SOL balance** for their buy amount plus fees

#### 2. Batch Buy Token
- **POST** `/api/pump/batch-buy`
- **Body:** 
  ```json
  {
    "mintAddress": "...",
    "solAmountPerWallet": 0.01,
    "slippageBps": 2500,
    "targetWalletNames": ["Bundled Wallet 5", ...], // optional
    "wallets": [
      {"name": "DevWallet", "privateKey": "base58_private_key_here"},
      {"name": "First Bundled Wallet 1", "privateKey": "base58_private_key_here"},
      {"name": "Bundled Wallet 5", "privateKey": "base58_private_key_here"}
    ]
  }
  ```
- **Parameter Details:**
  - **solAmountPerWallet**: SOL amount each wallet will spend (e.g., 0.01 for 0.01 SOL)
  - **slippageBps**: Slippage in basis points (e.g., 2500 = 25%). API converts to percentage format for pump.fun
  - **wallets**: Array of wallet objects with `name` and `privateKey` properties (required for stateless operation)
  - **targetWalletNames**: Optional filter to only use specific wallets from the provided wallets array
- **Response:** Bundle results, transaction details, status.
- **Important Notes:**
  - **Stateless Operation**: All wallet credentials must be provided in the request
  - **Eligible Wallets**: Automatically excludes DevWallet and First Bundled Wallets 1-4 from batch buying
  - **Private Keys**: Must be base58 encoded Solana keypairs
- **Minimum SOL Balance:** Each wallet needs **0.025 SOL** minimum + buy amount (tipper wallet needs 0.055 SOL minimum + buy amount)

#### 3. DevWallet Sell
- **POST** `/api/pump/sell-dev`
- **Body:** 
  ```json
  {
    "mintAddress": "...",
    "sellAmountPercentage": "50%", // or 50
    "slippageBps": 2500,
    "wallets": [
      {"name": "DevWallet", "privateKey": "base58_private_key_here"}
    ]
  }
  ```
- **Parameter Details:**
  - **sellAmountPercentage**: Percentage of tokens to sell (e.g., "50%" or 50)
  - **slippageBps**: Slippage in basis points (e.g., 2500 = 25%). API converts to percentage format for pump.fun
  - **wallets**: Array of wallet objects containing at least the DevWallet (required for stateless operation)
- **Response:** Transaction signature, transaction details, status.
- **Important Notes:**
  - **Simplified Operation**: No client-side token balance lookups required. The API validates percentage and passes it directly to Pump Portal for server-side balance calculation
  - **Stateless Operation**: DevWallet credentials must be provided in the request
  - **Balance Validation**: Token balance validation and amount calculation handled by Pump Portal API
  - **Zero Balance Handling**: Graceful error handling if wallet has zero token balance
  - **Required Wallet**: The wallets array must contain a wallet named "DevWallet"
  - **Private Keys**: Must be base58 encoded Solana keypairs
- **Minimum SOL Balance:** DevWallet needs **0.055 SOL** minimum to cover transaction fees and priority fees

#### 4. Batch Sell (All Non-DevWallets)
- **POST** `/api/pump/batch-sell`
- **Body:** 
  ```json
  {
    "mintAddress": "...",
    "sellAmountPercentage": "100%", // or 100
    "slippageBps": 2500,
    "targetWalletNames": ["Bundled Wallet 5", ...], // optional
    "wallets": [
      {"name": "First Bundled Wallet 1", "privateKey": "base58_private_key_here"},
      {"name": "First Bundled Wallet 2", "privateKey": "base58_private_key_here"},
      {"name": "Bundled Wallet 5", "privateKey": "base58_private_key_here"}
    ]
  }
  ```
- **Parameter Details:**
  - **sellAmountPercentage**: Percentage of tokens to sell (e.g., "100%" or 100)
  - **slippageBps**: Slippage in basis points (e.g., 2500 = 25%). API converts to percentage format for pump.fun
  - **wallets**: Array of wallet objects with `name` and `privateKey` properties (required for stateless operation)
  - **targetWalletNames**: Optional filter to only use specific wallets from the provided wallets array
- **Response:** Parallel transaction signatures, transaction details, status.
- **Important Notes:**
  - **Simplified Operation**: No client-side token balance lookups or pre-filtering. The API sends percentage string to all wallets and lets Pump Portal handle balance validation
  - **Stateless Operation**: All wallet credentials must be provided in the request
  - **Zero Balance Handling**: Wallets with zero token balance are handled gracefully with clear error messages from Pump Portal
  - **Excluded Wallets**: Automatically excludes DevWallet from batch selling (use `/api/pump/sell-dev` for DevWallet)
  - **Parallel Execution**: Processes sells in batches of 2-5 transactions (depending on RPC type) for optimal rate limit compliance
  - **Private Keys**: Must be base58 encoded Solana keypairs
- **Minimum SOL Balance:** Each wallet needs **0.025 SOL** minimum to cover transaction fees and priority fees

---

## **Bonk Pool Trading Endpoints**

**Overview:** The Bonk pool endpoints provide the same functionality as Pump endpoints but operate on the Bonk pool. Token creation uses the Lightning API with external IPFS storage, while buy/sell operations use local transactions with `pool: "bonk"` parameter.

**Key Differences from Pump Pool:**
- **Token Creation**: Uses Lightning API with wallet-specific API key (replaces dev wallet private key)
- **IPFS Storage**: Uses `nft-storage.letsbonk22.workers.dev` instead of Pinata
- **API Key Per Wallet**: Each Lightning wallet has its own API key (provided in request, not environment variable)
- **Buy/Sell Operations**: Same local transaction system but with `pool: "bonk"`

### **Core Bonk Endpoints**

#### 1. Create Bonk Token and Buy
- **POST** `/api/bonk/create-and-buy`
- **Content-Type:** `multipart/form-data` (for image upload)
- **Body:**
  ```bash
  curl -X POST http://localhost:3000/api/bonk/create-and-buy \
    -F "name=My Bonk Token" \
    -F "symbol=BONK" \
    -F "description=A great Bonk token" \
    -F "showName=true" \
    -F "createAmountSOL=0.5" \
    -F "slippageBps=2500" \
    -F "devWalletApiKey=your_lightning_wallet_api_key_here" \
    -F "buyAmountsSOL={\"devWalletBuySOL\":0.01,\"firstBundledWallet1BuySOL\":0.01}" \
    -F "wallets=[{\"name\":\"DevWallet\",\"privateKey\":\"base58_private_key_here\"},{\"name\":\"First Bundled Wallet 1\",\"privateKey\":\"base58_private_key_here\"}]" \
    -F "image=@/path/to/token-image.png"
  ```
- **Response:** Mint address, create signature, buy signatures, metadata URI, pool type
- **Important Notes:**
  - **Lightning API**: Token creation uses Lightning API with wallet-specific API key
  - **External IPFS**: Images uploaded to `nft-storage.letsbonk22.workers.dev`
  - **API Key Per Wallet**: Each Lightning wallet has its own API key (replaces private key for creation)
  - **Dev Wallet Access**: Uses `devWalletApiKey` parameter (no dev wallet private key needed for creation, unless a buy will be performed from dev wallet, in such case private key is needed)
  - **Buy Operations**: Use local transactions with `pool: "bonk"` and standard private keys
  - **Minimum SOL Balance**: Same requirements as Pump pool

#### 2. Bonk Batch Buy
- **POST** `/api/bonk/batch-buy`
- **Body:**
  ```json
  {
    "mintAddress": "token_mint_address_here",
    "solAmountPerWallet": 0.01,
    "slippageBps": 2500,
    "targetWalletNames": ["Bundled Wallet 5", "Bundled Wallet 6"],
    "wallets": [
      {"name": "Bundled Wallet 5", "privateKey": "base58_private_key_here"},
      {"name": "Bundled Wallet 6", "privateKey": "base58_private_key_here"}
    ]
  }
  ```
- **Response:** Signatures, wallets used, total SOL spent, pool type
- **Important Notes:**
  - Uses local transactions with `pool: "bonk"`
  - Excludes DevWallet and First Bundled Wallets 1-4
  - Parallel execution in batches of 4 transactions

#### 3. Bonk Dev Sell
- **POST** `/api/bonk/sell-dev`
- **Body:**
  ```json
  {
    "mintAddress": "token_mint_address_here",
    "sellAmountPercentage": "50%",
    "slippageBps": 2500,
    "wallets": [
      {"name": "DevWallet", "privateKey": "base58_private_key_here"}
    ]
  }
  ```
- **Response:** Signature, tokens sold, percentage, dev wallet address, pool type
- **Important Notes:**
  - **Simplified Operation**: Uses percentage-based selling without client-side balance lookups
  - Uses local transactions with `pool: "bonk"`
  - Only DevWallet can use this endpoint
  - **Balance Validation**: Token balance validation and amount calculation handled by Pump Portal API
  - **Zero Balance Handling**: Graceful error handling if wallet has zero token balance

#### 4. Bonk Batch Sell
- **POST** `/api/bonk/batch-sell`
- **Body:**
  ```json
  {
    "mintAddress": "token_mint_address_here",
    "sellAmountPercentage": "100%",
    "slippageBps": 2500,
    "targetWalletNames": ["Bundled Wallet 5"],
    "wallets": [
      {"name": "Bundled Wallet 5", "privateKey": "base58_private_key_here"},
      {"name": "Bundled Wallet 6", "privateKey": "base58_private_key_here"}
    ]
  }
  ```
- **Response:** Signatures, wallets used, total tokens sold, pool type
- **Important Notes:**
  - **Simplified Operation**: No client-side token balance lookups or pre-filtering. Sends percentage string to all wallets
  - Uses local transactions with `pool: "bonk"`
  - **Zero Balance Handling**: Wallets with zero token balance are handled gracefully with clear error messages
  - Excludes DevWallet (use `/api/bonk/sell-dev` for DevWallet)
  - Parallel execution in batches of 2-5 transactions (depending on RPC type) for optimal rate limit compliance

### **Bonk Pool Setup Requirements**

#### Lightning Wallet Setup
- **Lightning Wallet Creation**: Create Lightning wallets via create-wallet endpoint (future endpoint)
- **Wallet Credentials**: Each Lightning wallet provides: public key, private key, and API key
- **API Key Usage**: API key replaces private key for token creation via Lightning API

#### API Key Authentication
- **Token Creation**: Uses wallet-specific API key (provided in `devWalletApiKey` parameter)
- **Dev Wallet**: API key replaces private key for creation operations
- **Buy/Sell Operations**: Use standard wallet private keys (not API keys)

#### IPFS Storage
- **Image Upload**: `https://nft-storage.letsbonk22.workers.dev/upload/img`
- **Metadata Upload**: `https://nft-storage.letsbonk22.workers.dev/upload/meta`
- **Metadata Structure**: Compatible with Bonk.fun standards

### **Bonk vs Pump Comparison**

| Feature | Pump Pool | Bonk Pool |
|---------|-----------|----------|
| Token Creation | Local transactions | Lightning API |
| IPFS Storage | Pinata | nft-storage.letsbonk22.workers.dev |
| Dev Wallet Auth | Private key | Wallet-specific API key |
| API Key Source | Not required | Per-wallet (from Lightning wallet creation) |
| Buy/Sell Operations | Local transactions | Local transactions |
| Pool Parameter | `"pump"` | `"bonk"` |
| Parallel Execution | 4 transactions | 4 transactions |
| Error Handling | Same | Same |
| Confirmation | WebSocket | WebSocket |

---

## General Notes

- All endpoints return JSON.
- All endpoints perform input validation and return clear error messages on invalid input.
- All trading endpoints use robust transaction handling, local transactions via Pump Portal API, and follow Solana best practices for reliability.
- **Fully Stateless Operation**: All trading endpoints now require wallet credentials to be provided in each request - no server-side wallet storage.
- **Simplified Sell Operations**: Sell endpoints no longer require client-side token balance lookups. Percentage validation and amount calculation is handled server-side by Pump Portal API for improved efficiency and rate limit compliance.
- Private keys are never returned by trading endpoints.
- All transaction results include transaction signatures for on-chain verification.
- **Wallet Parameter Format**: All trading endpoints expect a `wallets` array with objects containing `name` and `privateKey` properties.
- **Private Key Format**: All private keys must be base58 encoded Solana keypairs.
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
  - *Expected:* No client-side balance lookups required, percentage-based operation handled by Pump Portal.
- **Batch-sell endpoint sells the specified percentage of tokens from all non-DevWallets.**
  - *Expected:* All specified wallets sell tokens, transactions are confirmed, balances update.
  - *Expected:* Zero-balance wallets handled gracefully with clear error messages, no pre-filtering required.

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
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Start the indexer + API server
npm run api
# or directly:
node ./src/api.js

# Docker: build and run
docker build -t xchain-indexer .
docker run xchain-indexer
docker run -d xchain-indexer   # background

# Follow logs of a running container
docker logs --follow --tail 10 CONTAINER_ID

# Reset the indexer database (drops and recreates)
# Run in MariaDB: drop database XChain_Indexer; create database XChain_Indexer;
```

There are no tests or linters configured in this project.

## Environment Configuration

Copy `.env` and configure before running. Required variables:

```
DECODER_DB_HOST / PORT / NAME / USER / PASS  # read-only source DB
INDEXER_DB_HOST / PORT / NAME / USER / PASS  # write target DB
INDEXER_API_PORT                              # default 3000
INDEXER_COIN      # BTC | LTC | DOGE
INDEXER_NETWORK   # mainnet | testnet | regtest
```

## Architecture Overview

The indexer reads decoded blockchain transactions from a **Decoder database** (`XChain_Decoder`) and processes/stores them into the **Indexer database** (`XChain_Indexer`). These are two separate MariaDB databases.

### Entry point & main loop

`src/api.js` — Starts an Express JSON-RPC API server and instantiates `XChainIndexer`. The main loop polls for new blocks every 5 seconds (`BLOCK_CHECK_INTERVAL`), handles block reorgs, processes transactions, checks for expirations/cancellations, and runs a sanity check after each block.

### Core classes

| File | Role |
|------|------|
| `src/XChainIndexer.js` | Main orchestrator class; owns the block-processing loop |
| `src/db.js` | `Database` class — MariaDB pool connections, all SQL queries |
| `src/actions.js` | `Actions` class — loads all action handlers, routes transactions |
| `src/config.js` | Builds full config from env vars + COIN config |
| `src/configs/<COIN>.js` | Coin-specific config (fees, network addresses) for BTC/LTC/DOGE |
| `src/utility.js` | `Utility` class — math helpers, timers, expiration/market processing |
| `src/mapper.js` | `Mapper` class — creates `action_index` → address/tick lookup records |
| `src/rollback.js` | `Rollback` class — handles blockchain reorganizations |
| `src/protocol_changes.js` | `ProtocolChanges` class — defines supported actions and activation blocks |

### Action handlers (`src/actions/*.js`)

Each XChain ACTION has its own class. The `Actions` class instantiates all handlers and routes incoming transactions to the correct one. Each action's `parse()` method validates parameters and writes to the indexer DB.

Actions with automatic lifecycle events have companion files:
- `dispenser_close.js`, `dispenser_expire.js` — triggered by `utility.js` expiration/cancellation logic
- `order_expire.js`, `order_match.js`
- `swap_expire.js`, `swap_match.js`

### SQL schema (`src/sql/*.sql`)

SQL files define table schemas loaded by `db.js` to initialize the indexer database. Table names mirror action names (e.g., `sends.sql`, `issues.sql`). Index tables (`index_*.sql`) define lookup indices; mapping tables (`mappings_*.sql`) store `action_index` associations.

### Docker runtime path

The Dockerfile copies source to `/XChainIndexer/`. `src/config.js` hard-codes the coin config path as `/XChainIndexer/src/configs/<COIN>.js`, so the indexer **must** run inside Docker or with the source mounted at that path.

### Block reorg handling

On each loop iteration, the indexer checks for a reorg block in the Decoder DB. If detected, `Rollback.rollback(blockNumber)` deletes all indexer DB records with `action_index` or `block_index` >= the reorg block, then re-indexes from that point.

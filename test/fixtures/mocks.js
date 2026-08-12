/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Mock objects for xchain-indexer unit tests
 *
 * Provides MockDatabase, mock indexer, and factory helpers
 * so action handlers and other classes can be tested without MariaDB.
 */

const sinon = require('sinon');
const { getTestConfig } = require('./config');

/**
 * Creates a stub database with every public method as a sinon stub.
 * Callers can override return values per test:
 *   mockDb.getTokenInfo.resolves({ TICK: 'TEST', ... });
 */
function createMockDb() {
    const db = {
        // Connection / transaction
        getConnection: sinon.stub().resolves({}),
        releaseConnection: sinon.stub().resolves(),
        beginTransaction: sinon.stub().resolves(),
        commitTransaction: sinon.stub().resolves(true),
        rollbackTransaction: sinon.stub().resolves(),
        doQuery: sinon.stub().resolves([]),
        verifyDatabase: sinon.stub().resolves(true),
        verifyTables: sinon.stub().resolves(true),

        // Block management
        getBlockIndex: sinon.stub().resolves(null),
        getBlockTime: sinon.stub().resolves(1700000000),
        getBlockHashes: sinon.stub().resolves({ ledger: 'abc', actions: 'def' }),
        createBlock: sinon.stub().resolves(['abc12', 'def34']),
        createReorg: sinon.stub().resolves(),
        getDecoderBlockData: sinon.stub().resolves([]),

        // Index / ID management
        getTransactionId: sinon.stub().resolves(1),
        createTransaction: sinon.stub().resolves(1),
        getAddressId: sinon.stub().resolves(1),
        createAddress: sinon.stub().resolves(1),
        // Identity by default: a ^<id> reference resolves to its canonical address in
        // production, but tests pass full addresses, so returning the input unchanged
        // keeps existing handler-validation outcomes. Override per-test to exercise
        // ^<id> resolution.
        resolveAddressRef: sinon.stub().callsFake(async (v) => v),
        // gated companion: same identity resolution, verdict OFF by default so
        // existing handler expectations (reject via the field's own isCryptoAddress
        // check) are unchanged. Override per-test to exercise the strict flag-day.
        resolveAddressRefChecked: sinon.stub().callsFake(async (v) => ({ value: v, rejected: false })),
        isCaretRefStrictActive: sinon.stub().returns(false),
        getBlockId: sinon.stub().resolves(1),
        getActionId: sinon.stub().resolves(1),
        createAction: sinon.stub().resolves(1),
        getNextTxIndex: sinon.stub().resolves(1),
        getTxIndex: sinon.stub().resolves(1),
        createTxIndex: sinon.stub().resolves(1),
        getNextActionIndex: sinon.stub().resolves(1),
        // Source-chain reorg fence (item 5308): default the bump to generation 1 (pre-bump 0), so a
        // rollback under the mock threads retraction_generation = 0 into the retraction calls.
        getPushGeneration: sinon.stub().resolves(0),
        bumpPushGeneration: sinon.stub().resolves(1),
        // Hub-push durability: enqueueHubPushTx write-aheads a retraction row inside the rollback
        // transaction and returns its id (distinct per call); markHubPushDelivered drops it on a
        // successful immediate delivery. enqueueHubPush is the pooled (non-tx) forward-push variant.
        enqueueHubPush: sinon.stub().resolves(),
        enqueueHubPushTx: (() => { let n = 0; return sinon.stub().callsFake(async () => ++n); })(),
        markHubPushDelivered: sinon.stub().resolves(),
        // PRICE forward pushes stage their durable row for a post-commit live-delivery attempt.
        stageHubPush: sinon.stub(),
        takeStagedHubPushes: sinon.stub().returns([]),
        getActionIndex: sinon.stub().resolves(null),
        createActionIndex: sinon.stub().resolves(1),
        updateActionIndex: sinon.stub().resolves(),
        deleteActionIndex: sinon.stub().resolves(),

        // Ticker management
        getTicker: sinon.stub().resolves('TEST'),
        getTickerId: sinon.stub().resolves(1),
        createTicker: sinon.stub().resolves(1),

        // Programmable policy layer: controller bindings (default: no controller bound, so
        // maybeRunControllerGuard bails early and uncontrolled-token behavior is unchanged).
        getEffectiveTokenController: sinon.stub().resolves(null),
        getEffectiveAddressController: sinon.stub().resolves(null),
        // Enforcement resolver (most-specific-wins with 'all' fallback). Defaults to no controller;
        // override per-test to exercise gating. Mirrors the real db.js *ForGuard composition.
        getEffectiveTokenControllerForGuard: sinon.stub().resolves(null),
        getEffectiveAddressControllerForGuard: sinon.stub().resolves(null),
        getActiveTokenControllerRow: sinon.stub().resolves(null),
        getActiveAddressControllerRow: sinon.stub().resolves(null),
        getTokenControllers: sinon.stub().resolves(new Map()),
        getAddressControllers: sinon.stub().resolves(new Map()),
        recordTokenControllerEvent: sinon.stub().resolves(),
        recordAddressControllerEvent: sinon.stub().resolves(),

        // Token info
        getTokenInfo: sinon.stub().resolves(null),
        getTokenDecimalPrecision: sinon.stub().resolves(0),
        getTokenSupply: sinon.stub().resolves(0),
        getTokenSupplyToken: sinon.stub().resolves(0),
        getTokenSupplyBalance: sinon.stub().resolves(0),
        getTokenSupplyEscrow: sinon.stub().resolves(0),
        getHolders: sinon.stub().resolves({}),
        isDistributed: sinon.stub().resolves(false),

        // Balance
        getAddressBalances: sinon.stub().resolves({}),
        // VM gateway ledger snapshot (getBalance / getTokenInfo backing)
        buildVmBalancesAndTokenInfo: sinon.stub().resolves({ balances: {}, tokenInfo: {} }),
        // VM attestation-response snapshot (xchain.attestation.getResponse backing).
        // Default empty; suites asserting getResponse behaviour override per-test.
        getAttestationDataForVM: sinon.stub().resolves({ responses: {} }),
        // Chunked DEPLOY (v4 carrier storage + DEPLOY v2/v3 assembly)
        recordDeployChunk: sinon.stub().resolves(),
        getDeployChunksForAssembly: sinon.stub().resolves([]),
        getAddressTableBalances: sinon.stub().resolves({}),
        getAddressCreditDebit: sinon.stub().resolves({}),
        updateBalances: sinon.stub().resolves(),
        updateAddressBalance: sinon.stub().resolves(),

        // Token updates
        updateTokens: sinon.stub().resolves(),
        updateTokenInfo: sinon.stub().resolves(),

        // Lists
        isValidList: sinon.stub().resolves(false),
        getListType: sinon.stub().resolves(false),
        getList: sinon.stub().resolves([]),
        // edit-chain resolution: armed on regtest, so the mock answers true
        // and getListRootIndex is identity unless a test overrides it.
        isListEditResolutionActive: sinon.stub().returns(true),
        getListRootIndex: sinon.stub().callsFake(async (action_index) => action_index),
        getListHeadIndex: sinon.stub().callsFake(async (action_index) => action_index),

        // BET parimutuel betting (P4)
        getBetFeedInfo: sinon.stub().resolves(false),
        getOpenBetsByFeed: sinon.stub().resolves([]),
        countOpenBetsByFeed: sinon.stub().resolves(0),
        createBetFeed: sinon.stub().resolves(),
        createBet: sinon.stub().resolves(),
        createBetCancel: sinon.stub().resolves(),
        createBetResolve: sinon.stub().resolves(),
        createBetFeedStatus: sinon.stub().resolves(),
        createBetStatus: sinon.stub().resolves(),
        setBetFeedTerminal: sinon.stub().resolves(),
        setBetSettled: sinon.stub().resolves(),
        latchBetFeedClosed: sinon.stub().resolves(),
        getBetFeedsDueLatch: sinon.stub().resolves([]),
        getBetFeedsDueExpiry: sinon.stub().resolves([]),
        getBetFeedRows: sinon.stub().resolves([]),
        getBetFeedPools: sinon.stub().resolves([]),
        getBetRows: sinon.stub().resolves([]),
        createList: sinon.stub().resolves(),
        createListEdit: sinon.stub().resolves(),
        createListItem: sinon.stub().resolves(),
        createListItemInvalid: sinon.stub().resolves(),

        // Status
        getStatusId: sinon.stub().resolves(1),
        createStatus: sinon.stub().resolves(1),

        // Ledger
        createCredit: sinon.stub().resolves(),
        createDebit: sinon.stub().resolves(),
        createEscrow: sinon.stub().resolves(),
        createLedgerChangeRecord: sinon.stub().resolves(),

        // Ownership-escrow / token-gating / link reads. Defaults are the
        // neutral path (not escrowed / no gated keys / no linked ISSUE tick);
        // tests that exercise those features override the stub per-case.
        isOwnershipEscrowed: sinon.stub().resolves(false),
        getActiveGatedKeyHashes: sinon.stub().resolves([]),
        // PC-29: packs with thresholds. Default is 'no gated packs', so an ungated
        // SEND needs no per-test setup and never reads a destination balance.
        getGatedPackThresholds: sinon.stub().resolves([]),
        getIssueTick: sinon.stub().resolves(null),

        // Action records
        createIssue: sinon.stub().resolves(),
        createToken: sinon.stub().resolves(),
        createMint: sinon.stub().resolves(),
        createSend: sinon.stub().resolves(),
        createDestroy: sinon.stub().resolves(),
        createAirdrop: sinon.stub().resolves(),
        createBatch: sinon.stub().resolves(),
        createBroadcast: sinon.stub().resolves(),
        createCallback: sinon.stub().resolves(),
        createDividend: sinon.stub().resolves(),
        createFile: sinon.stub().resolves(),
        createLink: sinon.stub().resolves(),
        createMessage: sinon.stub().resolves(),
        createSleep: sinon.stub().resolves(),
        createSweep: sinon.stub().resolves(),
        createFeeRecord: sinon.stub().resolves(),
        createAddressOption: sinon.stub().resolves(),
        createMemo: sinon.stub().resolves(1),
        getMemoId: sinon.stub().resolves(1),

        // Order
        createOrder: sinon.stub().resolves(),
        createOrderStatus: sinon.stub().resolves(),
        createOrderCancel: sinon.stub().resolves(),
        createOrderExpire: sinon.stub().resolves(),
        createOrderEdit: sinon.stub().resolves(),
        createOrderMatch: sinon.stub().resolves(),
        findOrderMatches: sinon.stub().resolves([]),
        getOrderInfo: sinon.stub().resolves(null),
        getOrderEdits: sinon.stub().resolves([]),
        getOrderAmountsRemaining: sinon.stub().resolves({}),
        getOrderMatchOrders: sinon.stub().resolves(false),
        getOrderMatchAmounts: sinon.stub().resolves(false),

        // COINPay
        createCoinpay: sinon.stub().resolves(),
        createCoinpayObligation: sinon.stub().resolves(),
        createCoinpayStatus: sinon.stub().resolves(),
        createCoinpayExpire: sinon.stub().resolves(),
        getCoinpayObligationInfo: sinon.stub().resolves(null),
        getExpiredCoinpayObligations: sinon.stub().resolves([]),
        getPendingCoinpayObligationsByOrder: sinon.stub().resolves([]),

        // Swap
        createSwap: sinon.stub().resolves(),
        createSwapStatus: sinon.stub().resolves(),
        createSwapCancel: sinon.stub().resolves(),
        createSwapExpire: sinon.stub().resolves(),
        createSwapEdit: sinon.stub().resolves(),
        createSwapMatch: sinon.stub().resolves(),
        findSwapMatches: sinon.stub().resolves([]),
        getSwapInfo: sinon.stub().resolves(null),
        getSwapEdits: sinon.stub().resolves([]),

        // Dispenser
        createDispenser: sinon.stub().resolves(),
        createDispenserStatus: sinon.stub().resolves(),
        createDispenserEdit: sinon.stub().resolves(),
        createDispenserCancel: sinon.stub().resolves(),
        createDispenserClose: sinon.stub().resolves(),
        createDispenserExpire: sinon.stub().resolves(),
        createDispense: sinon.stub().resolves(),
        findCancelledDispensers: sinon.stub().resolves([]),
        findDispenserSends: sinon.stub().resolves([]),
        findMatchingDispensers: sinon.stub().resolves([]),
        getDispenserInfo: sinon.stub().resolves(null),
        hasDispenserOriginStanding: sinon.stub().resolves(false),
        // Indexer-local dispenser freshness (dispenser_freshness_activation.js).
        // Default false = no prior XChain activity = fresh address; tests that need a
        // stale/non-fresh GET_ADDRESS resolve(true).
        hasXChainActivityBefore: sinon.stub().resolves(false),
        // Derived dispenser caps counts (dispenser_caps_activation.js). Defaults model
        // a fresh dispenser (no refills, no dispenses); cap tests resolve specific counts.
        getDispenserRefillCount: sinon.stub().resolves(0),
        getDispenserDispenseCount: sinon.stub().resolves(0),
        getDispenserEdits: sinon.stub().resolves([]),
        getDispenserAmountRemaining: sinon.stub().resolves(0),
        getSweepDestination: sinon.stub().resolves(null),
        getDispenserCanceller: sinon.stub().resolves(null),
        getClosedDispenserAtAddress: sinon.stub().resolves(false),

        // Sleep / authorization
        isAddressSleeping: sinon.stub().resolves(false),
        isTickSleeping: sinon.stub().resolves(false),
        isActionAllowed: sinon.stub().resolves(true),

        // Validation
        getFirstIssueActionIndex: sinon.stub().resolves(1),
        validTickerBeforeTxIndex: sinon.stub().resolves(true),
        isActionIndexValid: sinon.stub().resolves(true),
        getActionIndexTable: sinon.stub().resolves('issues'),
        getActionType: sinon.stub().resolves('ISSUE'),
        getActionData: sinon.stub().resolves(null),
        getActionCreditDebitAmount: sinon.stub().resolves(0),
        getSelfMintedAmount: sinon.stub().resolves(0),

        // Preferences
        getAddressPreferences: sinon.stub().resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 }),
        getAddressOwnerships: sinon.stub().resolves({}),

        // Market
        getMarkets: sinon.stub().resolves([]),
        getMarketId: sinon.stub().resolves(1),
        createMarket: sinon.stub().resolves(1),
        getMarketInfo: sinon.stub().resolves({}),
        updateMarketInfo: sinon.stub().resolves(),
        updateMarkets: sinon.stub().resolves(),

        // Expiration
        getExpiredItems: sinon.stub().resolves([]),

        // Mappings
        createActionMapping: sinon.stub().resolves(),
        createActionMappings: sinon.stub().resolves(),
        createFileMapping: sinon.stub().resolves(),

        // Coin / Fiat / Mime
        getCoinId: sinon.stub().resolves(1),
        createCoin: sinon.stub().resolves(1),
        getFiatId: sinon.stub().resolves(1),
        createFiat: sinon.stub().resolves(1),
        getMimeTypeId: sinon.stub().resolves(1),
        createMimeType: sinon.stub().resolves(1),

        // Normalization
        normalizeDataValues: sinon.stub().callsFake(data => data),

        // Sanity
        sanityCheck: sinon.stub().resolves(),
    };
    // doQueryStrict shares the doQuery stub so tests that program read results/ordering via
    // db.doQuery (onFirstCall for firstActionIndex, etc.) transparently drive rollback.js's
    // strict pre-transaction reads too, preserving the single-counter call ordering the real
    // code had before those reads were hardened to throw-on-fault.
    db.doQueryStrict = db.doQuery;
    return db;
}

/**
 * Creates a minimal mock indexer object that can be passed to
 * class constructors (Actions, Rollback, ProtocolChanges, etc.)
 */
function createMockIndexer(overrides = {}) {
    const config = getTestConfig();
    const Utility = require('../../src/utility.js');

    // Use a real Utility instance (most methods are pure)
    const util = new Utility();

    const decoderDb = createMockDb();
    const indexerDb = createMockDb();

    // Create a mock mapper
    const mapper = {
        createMappings: sinon.stub().resolves(),
    };

    const indexer = {
        config,
        util,
        decoderDb,
        indexerDb,
        mapper,
        // Default to a permissive gate (regtest is genesis-active for every flag-day,
        // which is what this mock models). Tests that need a specific activation state
        // reassign indexer.protocolChanges after construction.
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        },
        ...overrides,
    };

    return indexer;
}

/**
 * Creates a base transaction data object as produced by Actions.processTransaction()
 */
function createBaseData(overrides = {}) {
    return {
        ACTION: 'SEND',
        FORMAT: 0,
        BLOCK_INDEX: 100,
        BLOCK_TIME: 1700000000,
        SOURCE: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        COIN: 'BTC',
        COIN_DESTINATION: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        COIN_AMOUNT: '0.00000000',
        TX_HASH: 'a'.repeat(64),
        TX_VOUT: 0,
        TX_DATA: 'SEND|0|TEST|100|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        TX_INDEX: 1,
        ACTION_INDEX: 1,
        ...overrides,
    };
}

/**
 * Creates a standard tokenInfo object as returned by db.getTokenInfo()
 */
function createTokenInfo(overrides = {}) {
    return {
        TICK: 'TEST',
        MAX_SUPPLY: '1000',
        MAX_MINT: '100',
        DECIMALS: 0,
        DESCRIPTION: 'Test token',
        MINT_SUPPLY: '0',
        SUPPLY: '500',
        OWNER: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        TRANSFER: null,
        TRANSFER_SUPPLY: null,
        LOCK_MAX_SUPPLY: 0,
        LOCK_MINT: 0,
        LOCK_MAX_MINT: 0,
        LOCK_MINT_SUPPLY: 0,
        LOCK_DESCRIPTION: 0,
        LOCK_SLEEP: 0,
        LOCK_CALLBACK: 0,
        CALLBACK_BLOCK: null,
        CALLBACK_TICK: null,
        CALLBACK_AMOUNT: null,
        ALLOW_LIST: null,
        BLOCK_LIST: null,
        MINT_ADDRESS_MAX: null,
        MINT_START_BLOCK: null,
        MINT_STOP_BLOCK: null,
        ...overrides,
    };
}

module.exports = {
    createMockDb,
    createMockIndexer,
    createBaseData,
    createTokenInfo,
};

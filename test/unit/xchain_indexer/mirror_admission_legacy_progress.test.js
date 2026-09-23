/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * A mirrored row carrying an admission map must never stop the block loop.
 *
 * THE SHAPE. An INERT indexer at cursor 277 reads a CROSS_SETTLE row carrying the valid map
 * {BTC:280} while applying block 278. If rebuilding its canonical throws, the block applier
 * rolls back and retries the same block forever. The compatibility table says that row keeps
 * the legacy bytes, its signatures then fail to verify, and the handler's ordinary
 * insufficient-quorum skip lets the block commit.
 *
 * WHAT IS DRIVEN. The real catch-up loop (catchUpToDecoder), the real parseBlock and
 * processBlock with their watchdog, commit and rollback, the real runBlockPasses and
 * runSettlementPasses, the real settlement pass and match select on a real Database, the
 * real action dispatch and the real CROSS_SETTLE handler with its quorum check over real
 * ed25519 signatures. What is stubbed is what this row is not about: the train gate and the
 * sync barriers answer "proceed", the passes other than settlement are no-ops, the escrow
 * release is a recorder, and the SQL engine is a stand-in that evaluates the two bind clause
 * shapes the select can issue (their text is pinned by the admission-binding suite's
 * mirrored-selects part).
 *
 * THE LEGS.
 *   - INERT, measured: regtest with no arming, the {BTC:280} row, cursor 277. Block 278
 *     commits, zero exceptions reach the block applier, and the row is skipped rather than
 *     settled because its signatures cover bytes an inert reader does not rebuild.
 *   - INERT consumer inside the producer-armed window: testnet, where the producer height
 *     is sized strictly below the consumer height, so a row can sit in the producer era while
 *     the reader is still INERT. The row carries no columns. It settles as a legacy row and
 *     the block commits.
 *   - ARMED, measured: regtest armed at 0 and the same row. The select excludes it at 278
 *     and 279 and admits it at 280, where its signatures verify and it settles.
 *
 * Restoring either refusal the gate used to raise turns one INERT leg red: the map-present
 * refusal fails the measured leg, the map-absent refusal fails the window leg.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const sinon  = require('sinon');

const { HAVE_HUB, load } = require('../consensus/admission_binding.test/helpers/arms.js');
const { RAILS } = require('../consensus/admission_binding.test/helpers/rail_fixtures.js');
const matchRow  = RAILS.find(([rail]) => rail === 'match')[1];

const dispatchMethods   = require('../../../src/actions/actions_class/dispatch.js');
const addressPrePass    = require('../../../src/actions/actions_class/address_pre_pass.js');
const eq                = require('../../../src/consensus/equivocation_header.js');
const gateRegistry      = require('../../../src/consensus/gate_registry');

const ROYALTY_KEY = 'cross_chain_royalty_activation.CROSS_CHAIN_ROYALTY_ACTIVATION';
const T0 = 1700000000;
const blockTime = (b) => T0 + Number(b) * 600;

// Large enough that the mid-catch-up reorg recheck never fires on these cursors.
const NO_REORG_RECHECK = 1e9;

// ---------------------------------------------------------------------------
// The signed row
// ---------------------------------------------------------------------------

// The match bytes a hub signs, spelled by hand so the signature does not come from the
// builder under test: the legacy fields, the royalty legs where that gate is active, the
// admission field when the hub stamped one, then the equivocation wrapper.
function spellMatchBytes(r, admissionField) {
    let raw = ['XMATCH', r.match_id, String(r.snapshot_block),
        r.a_chain, String(r.a_action_index), r.a_tick, String(r.a_amount), String(r.a_ownership), r.a_payout_addr,
        r.b_chain, String(r.b_action_index), r.b_tick, String(r.b_amount), String(r.b_ownership), r.b_payout_addr,
        String(r.effective_time), r.network, r.a_kind, String(r.a_filled_before), r.b_kind, String(r.b_filled_before)].join('|');
    if (gateRegistry.activeAt(ROYALTY_KEY, r.network, null, r.snapshot_block, null))
        raw += '|' + r.a_payout_legs + '|' + r.b_payout_legs;
    raw += admissionField;
    return eq.isEquivHeaderActive(r.snapshot_block, r.network)
        ? eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, r.match_id, r.finalizing_view, raw) : raw;
}

function makeSigner() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubkey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return {
        validators: [{ pubkey: pubkey, source: 'src-1', weight: '100' }],
        sign: (bytes) => JSON.stringify([{ pubkey: pubkey, sig: crypto.sign(null, Buffer.from(bytes, 'utf8'), privateKey).toString('hex') }])
    };
}

// The measured row: snapshot block 275, effective by the clock before 278, admitted at 280.
function measuredRow(network, snapshotBlock, cols) {
    return matchRow(snapshotBlock, Object.assign({
        network: network, status: 'finalized', effective_time: blockTime(snapshotBlock) + 60,
        admit_block_btc: null, admit_block_ltc: null, admit_block_doge: null
    }, cols));
}

// ---------------------------------------------------------------------------
// The SQL stand-in for the mirrored match select
// ---------------------------------------------------------------------------

const ARMED_CLAUSE = '((admit_block_btc IS NULL AND effective_time <= ?) OR (admit_block_btc IS NOT NULL AND admit_block_btc <= ?))';
const INERT_CLAUSE = 'AND effective_time <= ? AND';

// Evaluates the two bind clause shapes getEffectiveUnsettledMatches can issue and refuses
// anything else, so a changed select fails here loudly instead of reading an empty set.
function matchSelect(rows) {
    return async function (sql, args) {
        if (!/FROM cross_chain_matches/.test(sql)) throw new Error('unexpected strict read: ' + sql);
        const armed = sql.includes(ARMED_CLAUSE);
        if (!armed && !sql.includes(INERT_CLAUSE)) throw new Error('unrecognised bind clause: ' + sql);
        const network = args[0], bt = args[1], height = armed ? args[2] : null, coin = args[args.length - 1];
        return rows.filter(r => r.network === network && r.status === 'finalized'
            && (r.a_chain === coin || r.b_chain === coin)
            && (armed && r.admit_block_btc !== null ? r.admit_block_btc <= height : r.effective_time <= bt));
    };
}

// ---------------------------------------------------------------------------
// The indexer, assembled on its real prototype
// ---------------------------------------------------------------------------

// The Utility with the passes this suite is not about answering "nothing to do".
function buildUtil(h) {
    const util = new h.Utility();
    sinon.stub(util, 'logError');
    sinon.stub(util, 'processExpirations').resolves();
    sinon.stub(util, 'processBetPasses').resolves();
    sinon.stub(util, 'processContractDelegationMaterializations').resolves();
    return util;
}

// A real Database whose pool never connects, its transaction plumbing counted and its reads
// answered from the fixture.
function buildDb(h, config, util, { network, rows, validators }, record) {
    const db = new h.Database('127.0.0.1', 3306, 'xchain_btc_' + network, 'u', 'p', { config, util });
    const pool = db.pool;
    db.pool = { getConnection: sinon.stub().rejects(new Error('no database in this suite')) };
    if (pool && typeof pool.end === 'function') pool.end().catch(() => {});
    Object.assign(db, {
        beginTransaction:   async () => {},
        commitTransaction:  async () => { record.commits++; },
        rollbackTransaction: async () => { record.rollbacks++; },
        currentTxEpoch:     () => 1,
        runInTxEpoch:       (epoch, fn) => fn(),
        takeStagedHubPushes: () => [],
        doQueryStrict:      matchSelect(rows),
        doQuery:            async (sql) => {
            if (/FROM cross_chain_settlements/.test(sql)) return [];
            throw new Error('unexpected read: ' + sql);
        },
        getSwapInfo:        async () => ({ status: 'open' }),
        isActionIndexParsed: async () => true,
        getValidatorsByCapability:  async () => validators,
        getStakeWeightsByCapability: async () => validators
    });
    return db;
}

// The real dispatch and the real CROSS_SETTLE handler, with the escrow release and the bridge
// pass replaced by recorders.
function buildActions(h, config, util, db, protocolChanges, record) {
    const settleLeg = require('../../../src/actions/cross_settle/settle_leg.js');
    const actions = Object.assign({}, dispatchMethods, addressPrePass, {
        config, util, indexerDb: db, decoderDb: null, mapper: null, protocolChanges,
        _actionCounters: {}, _primaryVerdict: null
    });
    actions.actionCrossSettle = new h.Settle(actions);
    const parse = actions.actionCrossSettle.parse.bind(actions.actionCrossSettle);
    actions.actionCrossSettle.parse = async (params, data, error) => {
        record.dispatched.push(Number(data['BLOCK_INDEX']));
        return parse(params, data, error);
    };
    record.stubs.push(sinon.stub(settleLeg, 'settleSwapLeg').callsFake(async function (data, m) {
        record.settled.push(Number(data['BLOCK_INDEX']));
    }));
    record.stubs.push(sinon.stub(h.BS, 'processBridgeSettlePass').resolves());
    return actions;
}

function buildIndexer(h, fixture) {
    const { network, tip } = fixture;
    const record = { dispatched: [], settled: [], abandoned: [], commits: 0, rollbacks: 0, stubs: [] };
    const config = {
        COIN: 'BTC', NETWORK: network, GENESIS_BLOCK: 0, BLOCK_PROCESS_TIMEOUT: 30000,
        BLOCK_CHECK_INTERVAL: 5000, CHAIN_TIP_PUSH_MAX_LAG: 10
    };
    const util = buildUtil(h);
    const db = buildDb(h, config, util, fixture, record);
    const protocolChanges = { isEnabled: async () => true };
    const actions = buildActions(h, config, util, db, protocolChanges, record);

    const ix = Object.create(h.Indexer.prototype);
    Object.assign(ix, {
        config, util, actions, protocolChanges, indexerDb: db,
        decoderDb: {
            getDecoderBlockData: async () => [],
            getBlockTime:        async (b) => blockTime(b),
            getRawBlockTime:     async (b) => blockTime(b),
            getBlockIndex:       async () => tip
        },
        genesis:   { inject: async () => {} },
        hubClient: { pushChainTip: () => {} },
        checkTrainActivation:    async () => false,
        anchorAttestHorizonBound: async () => null,
        deferOnSyncBarriers:     async () => false,
        resolveBtcChainId:       async () => null,
        runCrossChainPasses:     async () => {},
        runRewardPasses:         async () => {},
        runClosingPasses:        async () => {},
        finalizeBlock:           async () => [0, 0, 0]
    });
    const abandon = h.Indexer.prototype.abandonBlock;
    ix.abandonBlock = async function (error, cursor) {
        record.abandoned.push(error);
        return abandon.call(this, error, cursor);
    };
    return { ix, record };
}

async function drive(h, fixture, cursor) {
    const { ix, record } = buildIndexer(h, fixture);
    try {
        const out = await ix.catchUpToDecoder(null, NO_REORG_RECHECK, null, cursor, fixture.tip);
        record.cursor = out.lastIndexerBlock;
    } finally {
        for (const s of record.stubs) s.restore();
    }
    return record;
}

// ---------------------------------------------------------------------------
// The legs
// ---------------------------------------------------------------------------

// One top-level block per leg, each arming itself in its own before hook.
const SUITE = 'mirror admission compatibility: a mirrored admission map never stops the block loop';

describe(SUITE, function () {

    describe('INERT consumer, the measured {BTC:280} row from cursor 277', function () {
        let h, record;
        before(async function () {
            h = load(null);
            const signer = makeSigner();
            const row = measuredRow('regtest', 275, { admit_block_btc: 280 });
            // What the armed producer signed: the legacy bytes plus the admission field.
            row.validator_signatures = signer.sign(spellMatchBytes(row, '|BTC:280'));
            record = await drive(h, { network: 'regtest', tip: 278, rows: [row], validators: signer.validators }, 277);
        });
        after(function () { if (h) h.restore(); h = null; });

        it('is INERT, so the select binds by the clock and the map is read as absent', function () {
            assert.strictEqual(h.act.isMirrorAdmissionConsumerActive('BTC', 'regtest', 278), false);
            assert.strictEqual(h.act.isAdmissionEra('regtest', 275), false);
        });

        it('commits block 278 from cursor 277', function () {
            assert.strictEqual(record.cursor, 278);
            assert.strictEqual(record.commits, 1);
        });

        it('lets zero exceptions reach the block applier', function () {
            assert.deepStrictEqual(record.abandoned.map(e => e && e.message), []);
            assert.strictEqual(record.rollbacks, 0);
        });

        it('reads the row at 278 and skips it on the ordinary quorum path, settling nothing', function () {
            assert.deepStrictEqual(record.dispatched, [278]);
            assert.deepStrictEqual(record.settled, []);
        });
    });
});

describe(SUITE, function () {

    describe('INERT consumer inside the producer-armed window, a row with no admission columns', function () {
        let h, record, B, P;
        before(async function () {
            h = load(null);
            P = h.act.MIRROR_ADMISSION_ACTIVATION['BTC:testnet'];
            const C = h.act.MIRROR_ADMISSION_CONSUMER_ACTIVATION['BTC:testnet'];
            // The window exists only while the producer height sits at least two blocks below the
            // consumer height; a re-slide that closes it leaves nothing for this leg to drive.
            if (!Number.isFinite(P) || !Number.isFinite(C) || !(P < C - 1)) { this.skip(); return; }
            B = C - 1;
            const signer = makeSigner();
            const row = measuredRow('testnet', P);
            row.validator_signatures = signer.sign(spellMatchBytes(row, ''));
            record = await drive(h, { network: 'testnet', tip: B, rows: [row], validators: signer.validators }, B - 1);
        });
        after(function () { if (h) h.restore(); h = null; });

        it('is the mixed window: the row is in the producer era while the reader is INERT', function () {
            assert.strictEqual(h.act.isAdmissionEra('testnet', P), true);
            assert.strictEqual(h.act.isMirrorAdmissionConsumerActive('BTC', 'testnet', B), false);
        });

        it('commits block B from cursor B - 1', function () {
            assert.strictEqual(record.cursor, B);
            assert.strictEqual(record.commits, 1);
        });

        it('lets zero exceptions reach the block applier', function () {
            assert.deepStrictEqual(record.abandoned.map(e => e && e.message), []);
            assert.strictEqual(record.rollbacks, 0);
        });

        it('settles the row as a legacy row', function () {
            assert.deepStrictEqual(record.dispatched, [B]);
            assert.deepStrictEqual(record.settled, [B]);
        });
    });
});

describe(SUITE, function () {

    describe('ARMED consumer, the measured {BTC:280} row from cursor 277', function () {
        let h, record, row;
        before(async function () {
            h = load(0);
            const signer = makeSigner();
            row = measuredRow('regtest', 275, { admit_block_btc: 280 });
            row.validator_signatures = signer.sign(spellMatchBytes(row, '|BTC:280'));
            record = await drive(h, { network: 'regtest', tip: 280, rows: [row], validators: signer.validators }, 277);
        });
        after(function () { if (h) h.restore(); h = null; });

        it('signs what an armed hub signs (PENDING here means no hub sibling, never a silent pass)', function () {
            if (!HAVE_HUB) { this.skip(); return; }
            assert.strictEqual(spellMatchBytes(row, '|BTC:280'),
                h.hub.Dex.prototype.canonicalMatch.call({}, row, row.finalizing_view));
        });

        it('commits 278, 279 and 280 with zero exceptions reaching the block applier', function () {
            assert.deepStrictEqual(record.abandoned.map(e => e && e.message), []);
            assert.strictEqual(record.commits, 3);
            assert.strictEqual(record.cursor, 280);
        });

        it('excludes the row through block 279 and admits and settles it at block 280', function () {
            assert.deepStrictEqual(record.dispatched, [280]);
            assert.deepStrictEqual(record.settled, [280]);
        });
    });
});

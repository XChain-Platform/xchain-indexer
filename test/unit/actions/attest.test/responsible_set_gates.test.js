// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// THE ATTEST HANDLER SUITE. One handler, split by behaviour across
// test/unit/actions/attest.test.js and its parts in test/unit/actions/attest.test/, every part under
// the same suite title so each full test title is what it was when the suite was
// one file. The shared setup, the wire builders and the fixture constants live in
// test/helpers/attest_fixture.js; the batch-rail fixtures in
// test/helpers/attest_batch_rail_fixture.js.
//
// This part: the flag days that shape the responsible set (source-deduped selection
// under the stake-weighted quorum, the admission rejection), and the BTC anchor of
// the responsible-set gate.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { createMockIndexer, createBaseData } = require('../../../fixtures/mocks');
const Attest = require('../../../../src/actions/attest/index.js');
const swq = require('../../../../src/stake_weighted_quorum.js');
const gateRegistry = require('../../../../src/consensus/gate_registry');
const { stubActiveAt } = require('../../../helpers/gate_modules.js');
const ADMISSION_KEY = 'attest_admission_activation.ATTEST_ADMISSION_ACTIVATION';
const srb = require('../../../../src/snapshot_reorg_buffer.js');
const { PUBKEY_A, deriveReqId, setUpAttestHandler } = require('../../../helpers/attest_fixture.js');
const { readRollbackSource } = require('../../../helpers/rollback_source.js');

// The handler under test and its mocked indexer, rebuilt before every test.
let indexer, handler;
function setUpHandler() {
    ({ indexer, handler } = setUpAttestHandler());
}

// ───────────────────────────────────────────────────────────────────────
// STAKE_WEIGHTED_QUORUM: source-deduped responsible-set selection
// The within-subset quorum stays count-based; only the SELECTION dedupes by
// staking source so a source's delegated keys can't occupy multiple slots.
// ───────────────────────────────────────────────────────────────────────
describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('STAKE_WEIGHTED_QUORUM: source-deduped responsible set', function () {
        beforeEach(function () {
            swq.isStakeWeightedQuorumActive.returns(true);   // already stubbed in outer beforeEach
        });

        it('selects at most one responsible slot per staking source', async function () {
            // S1 delegates THREE keys; S2 and S3 one each. redundancy 3.
            indexer.indexerDb.getStakeWeightsByCapability.resolves([
                { pubkey: 'k1a', source: 'S1', weight: '50000' },
                { pubkey: 'k1b', source: 'S1', weight: '50000' },
                { pubkey: 'k1c', source: 'S1', weight: '50000' },
                { pubkey: 'k2',  source: 'S2', weight: '50000' },
                { pubkey: 'k3',  source: 'S3', weight: '50000' },
            ]);
            const srcOf = { k1a: 'S1', k1b: 'S1', k1c: 'S1', k2: 'S2', k3: 'S3' };
            // Weights clear the http_get provider floor (10000) so this vector isolates the
            // source-dedupe rule; the floor itself is exercised in its own describe below.
            const resp = await handler.computeResponsibleSet('req-1', 3, 90, 'http_get');
            const sources = resp.map(pk => srcOf[pk]);
            assert.strictEqual(new Set(sources).size, sources.length, 'a source occupied >1 responsible slot');
            assert.deepStrictEqual([...new Set(sources)].sort(), ['S1', 'S2', 'S3']);
        });

        it('SECURITY: a source with many delegated keys cannot dominate the responsible set', async function () {
            // S1 delegates 5 keys; only S2 besides. redundancy 3, but just 2 sources.
            indexer.indexerDb.getStakeWeightsByCapability.resolves([
                ...['a', 'b', 'c', 'd', 'e'].map(s => ({ pubkey: 'k1' + s, source: 'S1', weight: '50000' })),
                { pubkey: 'k2', source: 'S2', weight: '50000' },
            ]);
            const resp = await handler.computeResponsibleSet('req-2', 3, 90, 'http_get');
            assert.strictEqual(resp.filter(pk => pk.startsWith('k1')).length, 1, 'S1 took more than one slot');
            assert.strictEqual(resp.length, 2, 'responsible set capped at the number of distinct sources');
        });

        it('uses the source-keyed query (not the count query) when weighted', async function () {
            indexer.indexerDb.getStakeWeightsByCapability.resolves([{ pubkey: 'k1', source: 'S1', weight: '50000' }]);
            await handler.computeResponsibleSet('req-3', 1, 90, 'http_get');
            // the declared block 90 is resolved at its buried height; the
            // stake-weighted flag-day still keys on the declared 90 (see snapshot_reorg_buffer.test.js).
            assert.ok(indexer.indexerDb.getStakeWeightsByCapability.calledWith(
                'attestation', srb.buriedSnapshotBlock(90, 'regtest')));
            assert.ok(indexer.indexerDb.getValidatorsByCapability.notCalled);
        });
    });
});

function v0Data(overrides = {}) {
    return createBaseData({
        ACTION: 'ATTEST', FORMAT: 0, IS_EMISSION: true, EMITTER: 5, EMITTER_POSITION: 0,
        EMITTER_PATH: '0', ROOT_ACTION_INDEX: 100, BLOCK_INDEX: 100,
        ...overrides,
    });
}
function v0Params(reqId, redundancy) {
    return ['0', reqId, 'http_get', 'q', 'onResult', '[]', String(redundancy), '50'];
}
function validReqId(data) {
    return deriveReqId(data['TX_HASH'], data['ROOT_ACTION_INDEX'], data['EMITTER_PATH'], data['EMITTER'], data['EMITTER_POSITION']);
}

// Pkg 7 / 87441a53 admission rejection: at/above ATTEST_ADMISSION_ACTIVATION
// an ATTEST v0 whose responsible set at the request block is smaller than
// REDUNDANCY is rejected at admission (immediate, never enters 'pending');
// below the gate the legacy accept-then-expire behavior is bit-identical.
describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST_ADMISSION flag-day: unservable-redundancy rejection', function () {
        beforeEach(function () {
            stubActiveAt(sinon, ADMISSION_KEY, true);   // stubbed off in the fixture's beforeEach
        });

        it('rejects a request whose responsible set is smaller than REDUNDANCY', async function () {
            // Snapshot has ONE validator (default stub); redundancy 3 is unservable.
            const data = v0Data();
            await handler.parse(v0Params(validReqId(data), 3), data, null);
            assert.ok(String(data['STATUS']).includes('REDUNDANCY'),
                'expected responsible-set rejection, got: ' + data['STATUS']);
            assert.strictEqual(data['REQUEST_STATUS'], 'rejected');
            assert.strictEqual(data['RESPONSIBLE_SET_JSON'], undefined,
                'a rejected request must not pin a responsible set');
        });

        it('accepts a request whose responsible set covers REDUNDANCY, pinning the SAME computed set', async function () {
            const data = v0Data();
            await handler.parse(v0Params(validReqId(data), 1), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.strictEqual(data['REQUEST_STATUS'], 'pending');
            assert.deepStrictEqual(JSON.parse(data['RESPONSIBLE_SET_JSON']), [PUBKEY_A]);
            // Reuses the admission-gate set: exactly ONE responsible-set query.
            assert.strictEqual(indexer.indexerDb.getValidatorsByCapability.callCount, 1,
                'admission gate + RESPONSIBLE_SET_JSON pin must share one computed set');
        });

        it('SWQ source-dedupe shrink below REDUNDANCY is rejected when the gate is active', async function () {
            // Weighted selection dedupes S1's delegated keys to one slot: 2 distinct
            // sources < redundancy 3, the exact 87441a53 liveness hole.
            swq.isStakeWeightedQuorumActive.returns(true);
            indexer.indexerDb.getStakeWeightsByCapability.resolves([
                { pubkey: 'k1a', source: 'S1', weight: '50000' },
                { pubkey: 'k1b', source: 'S1', weight: '50000' },
                { pubkey: 'k2',  source: 'S2', weight: '50000' },
            ]);
            const data = v0Data();
            await handler.parse(v0Params(validReqId(data), 3), data, null);
            assert.ok(String(data['STATUS']).includes('responsible set 2 < 3'),
                'expected deduped-set rejection, got: ' + data['STATUS']);
            assert.strictEqual(data['REQUEST_STATUS'], 'rejected');
        });
    });
});

describe('Attest (ATTEST) @regression @tier3', function () {
    beforeEach(setUpHandler);
    afterEach(() => sinon.restore());
    describe('ATTEST_ADMISSION flag-day: unservable-redundancy rejection', function () {
        beforeEach(function () {
            stubActiveAt(sinon, ADMISSION_KEY, true);   // stubbed off in the fixture's beforeEach
        });

        it('below the gate the legacy accept-then-expire path is preserved (replay bit-identical)', async function () {
            stubActiveAt(sinon, ADMISSION_KEY, false);
            const data = v0Data();
            await handler.parse(v0Params(validReqId(data), 3), data, null);
            assert.strictEqual(data['STATUS'], 'valid', 'pre-gate replay must still accept: ' + data['STATUS']);
            assert.strictEqual(data['REQUEST_STATUS'], 'pending');
        });

        it('gate queries the request block and network (real registry row sanity)', function () {
            // Un-stubbed registry semantics, read from the GateRegistry instance
            // beneath the stubbed module export: regtest/testnet armed at genesis,
            // mainnet at the STAKE_WEIGHTED_QUORUM anchor, unknown network off.
            const real = gateRegistry.registry;
            assert.strictEqual(gateRegistry.get(ADMISSION_KEY).mainnet, 961000);
            assert.strictEqual(real.activeAt(ADMISSION_KEY, 'regtest', null, 0, null), true);
            assert.strictEqual(real.activeAt(ADMISSION_KEY, 'mainnet', null, 960999, null), false);
            assert.strictEqual(real.activeAt(ADMISSION_KEY, 'mainnet', null, 961000, null), true);
            assert.strictEqual(real.activeAt(ADMISSION_KEY, 'nonet', null, 100, null), false);
            assert.strictEqual(real.activeAt(ADMISSION_KEY, 'regtest', null, 'x', null), false);
        });
    });
});

/*********************************************************************
 * the responsible-set SWQ gate is BTC-ANCHORED.
 *
 * isStakeWeightedQuorumActive() compares against 961000, a BTC height. But
 * computeResponsibleSet was handed the ATTEST action's LOCAL height, and ATTEST
 * is registered on all three chains. LTC and DOGE sit at ~3.16M and ~6.3M local,
 * so a non-BTC indexer resolved `weighted` TRUE out of band, long before the
 * anchor, while xchain-hub's AttestationRound resolved it FALSE from a real BTC
 * height (it polls the BTC indexer). The function's own header demands
 * byte-for-byte agreement with that hub routine "or validation forks".
 *
 * The disagreement is LATENT at HEAD, not exploitable: capability staking is
 * BTC-only and LTC/DOGE declare no STAKING.CAPABILITIES, so both lookups return
 * [] and the set is empty either way. These tests pin the plane so it stays
 * fixed if attestation is ever configured or mirrored off BTC, which is the
 * moment it would otherwise become a live fork.
 ********************************************************************/
describe('ATTEST responsible-set is BTC-anchored (#3233) @regression @tier1', function () {
    // A local height comfortably past the 961000 BTC anchor, which is where every
    // LTC/DOGE indexer already sits.
    const PAST_ANCHOR = 3160000;

    function handlerForCoin(coin) {
        const ix = createMockIndexer();
        ix.config.COIN    = coin;
        ix.config.NETWORK = 'mainnet';
        const db = ix.indexerDb;
        // Both lookups return a NON-empty set, so the test can observe which branch
        // ran. At HEAD these are empty off BTC, which is exactly what hides the bug.
        db.getStakeWeightsByCapability = sinon.stub().resolves([
            { pubkey: 'a'.repeat(64), source: 'src1', weight: '50000' },
            { pubkey: 'b'.repeat(64), source: 'src2', weight: '50000' }
        ]);
        db.getValidatorsByCapability = sinon.stub().resolves([
            { pubkey: 'a'.repeat(64) },
            { pubkey: 'b'.repeat(64) }
        ]);
        return { handler: new Attest({
            config: ix.config, util: ix.util, mapper: ix.mapper,
            decoderDb: ix.decoderDb, indexerDb: db,
            protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) }
        }), db };
    }

    afterEach(() => sinon.restore());

    for (const coin of ['LTC', 'DOGE']) {
        it(`${coin}: returns an empty set without consulting the BTC-anchored gate`, async function () {
            const { handler, db } = handlerForCoin(coin);
            const out = await handler.computeResponsibleSet('req-1', 2, PAST_ANCHOR, 'http_get');
            assert.deepStrictEqual(out, [],
                'capability staking is BTC-only; a non-BTC indexer has no responsible set');
            assert.strictEqual(db.getStakeWeightsByCapability.called, false,
                'the weighted branch must not be reached off BTC: resolving it from a local ' +
                'height already past 961000 is the out-of-band selection this fixes');
            assert.strictEqual(db.getValidatorsByCapability.called, false);
        });
    }

    it('BTC: still evaluates the gate, because there the local height IS a BTC height', async function () {
        const { handler, db } = handlerForCoin('BTC');
        const out = await handler.computeResponsibleSet('req-1', 2, PAST_ANCHOR, 'http_get');
        assert.strictEqual(out.length, 2, 'BTC must still resolve a responsible set');
        assert.strictEqual(db.getStakeWeightsByCapability.called, true,
            'past the anchor on BTC the weighted branch is correct and must still run');
    });

    it('BTC below the anchor takes the legacy unweighted branch', async function () {
        const { handler, db } = handlerForCoin('BTC');
        await handler.computeResponsibleSet('req-1', 2, 900000, 'http_get');
        assert.strictEqual(db.getValidatorsByCapability.called, true);
        assert.strictEqual(db.getStakeWeightsByCapability.called, false,
            'below 961000 the gate is off, so replay of pre-anchor history is unchanged');
    });
});

describe('ATTEST responsible-set is BTC-anchored (#3233) @regression @tier1', function () {
    afterEach(() => sinon.restore());

    // The two implementations are required to agree byte-for-byte; agreeing only by
    // both reaching [] via different routes is how they drift apart later.
    it('rollback.js short-circuits on the SAME condition, not just to the same answer', function () {
        // The recompute's methods and statements span the rollback entry, its parts and
        // src/db/rollback/, so the pin reads the module as one text.
        const src = readRollbackSource();
        assert.match(src, /if\(this\.config\['COIN'\] === 'BTC'\)/,
            'the reorg recompute must gate on COIN the way attest.js does, or ' +
            'reorg-recomputed missed_count diverges from the live expiry path');
        assert.match(src, /#3233/, 'and say why, so it is not "simplified" back');
    });
});

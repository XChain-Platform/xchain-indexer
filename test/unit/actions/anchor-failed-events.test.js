// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Row 4 of the proactive-system-watch spec: a refused ANCHOR says so.
//
// anchor.js prints an accepted and a refused anchor through the same
// console.log, at the same level, one word apart, so nothing reading the
// stream can separate them. These cases drive the REAL parser and assert the
// ANCHOR_FAILED record, and that an accepted anchor emits none.

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const Anchor        = require('../../../src/actions/anchor.js');
const ed25519       = require('../../../src/ed25519.js');
const swq           = require('../../../src/stake_weighted_quorum.js');
const diag          = require('../../../src/diagnosticEvents.js');
const observability = require('../../../src/observability');

const PUBKEY_A = 'a'.repeat(64);
const SIG      = '1'.repeat(128);
const HASH     = (c) => c.repeat(64);

// ANCHOR v0 params: header, SECTION_COUNT sections in wire order, then ONE
// publisher-attestation tail for the whole bundle.
function v0Params(overrides = {}) {
    const f = Object.assign({
        network: 'regtest', snapshot: '100',
        sections: [{ chain: 'BTC' }],
        publisher: PUBKEY_A, attest: [[PUBKEY_A, SIG]]
    }, overrides);
    const sections = f.sections.map(s => Object.assign({
        chain: 'BTC', block_index: '500', block_hash: HASH('0'),
        ledger: HASH('1'), actions: HASH('2'), contracts: HASH('3'),
        seq: '0', snapshot: f.snapshot,
        state_root: HASH('d'), state_root_version: '1',
        block_merkle_root: HASH('e'), block_merkle_version: '1',
        sigs: [[PUBKEY_A, SIG]]
    }, s));
    const p = ['0', f.network, f.snapshot, String(sections.length)];
    for (const s of sections) {
        p.push(s.chain, s.block_index, s.block_hash, s.ledger, s.actions, s.contracts,
               s.seq, s.snapshot, s.state_root, s.state_root_version,
               s.block_merkle_root, s.block_merkle_version, String(s.sigs.length));
        for (const [pk, sg] of s.sigs) p.push(pk, sg);
    }
    p.push(f.publisher, String(f.attest.length));
    for (const [pk, sg] of f.attest) p.push(pk, sg);
    return p;
}

describe('ANCHOR_FAILED: a refused anchor is separable from an accepted one @regression', function () {

    let indexer, handler, verifyStub, swqStub, sink;

    function failures() {
        return sink.lines.filter(l => l.includes('ANCHOR_FAILED'));
    }

    beforeEach(function () {
        observability._resetObservability();
        diag._resetDiagnostics();
        sink = { lines: [] };
        const push = (m) => sink.lines.push(m);
        observability.installObservability(null, {
            service: 'xchain-indexer', env: {}, console: { log: push, warn: push, error: push }
        });

        indexer = createMockIndexer();
        indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: 'regtest' });
        const db = indexer.indexerDb;
        db.getValidatorsByCapability  = sinon.stub().resolves([{ pubkey: PUBKEY_A, amount: '1' }]);
        db.hasCapability              = sinon.stub().resolves(true);
        db.getMaxAnchorCheckpointSeq  = sinon.stub().resolves(null);
        db.getArchiveReplayWatermarks = sinon.stub().resolves({ batchSeq: null, checkpointSeq: null });
        db.createAnchorAction         = sinon.stub().resolves();
        db.getAnchorV1ByBatchSeq      = sinon.stub().resolves(null);
        db.getAnchorChunks            = sinon.stub().resolves([]);
        db.setAnchorArchiveStatus     = sinon.stub().resolves();
        db.createValidatorReward      = sinon.stub().resolves(true);
        db.reconcileAnchorRewardWinner = sinon.stub().resolves(0);

        handler    = new Anchor(indexer);
        verifyStub = sinon.stub(ed25519, 'verify').returns(true);
        // These cases assert the legacy COUNT quorum path; the mocked
        // oracle_publish set carries no source or weight.
        swqStub    = sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    });

    afterEach(function () {
        verifyStub.restore(); swqStub.restore();
        sinon.restore();
        observability._resetObservability();
        diag._resetDiagnostics();
    });

    it('a refused v0 bundle emits one record carrying the verdict and the chains that parsed', async function () {
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(
            v0Params({ sections: [{ chain: 'BTC' }, { chain: 'LTC', state_root: 'nothex' }] }), data, null);

        assert.strictEqual(data['STATUS'], 'invalid: SECTION 1 STATE_ROOT (format)');
        assert.strictEqual(failures().length, 1);
        // Section parsing stops at the bad section, so the chain list is what the
        // parser got through, and the reason names the section that stopped it.
        assert.ok(failures()[0].includes('chain=BTC'), failures()[0]);
        assert.ok(failures()[0].includes('SECTION 1 STATE_ROOT'), failures()[0]);
        assert.ok(failures()[0].includes('network=regtest'), failures()[0]);
    });

    it('an accepted v0 bundle emits nothing: the happy path is not an event', async function () {
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ sections: [{ chain: 'BTC' }] }), data, null);

        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(failures().length, 0);
    });

    it('a bundle refused before any section parses still reports the reason', async function () {
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ network: 'mainnet' }), data, null);

        assert.strictEqual(data['STATUS'], 'invalid: NETWORK (not this network)');
        assert.strictEqual(failures().length, 1);
        assert.ok(failures()[0].includes('invalid: NETWORK (not this network)'), failures()[0]);
        // No section survived, so there is no chain to name and the record says so
        // rather than inventing one.
        assert.ok(failures()[0].includes('chain=unknown'), failures()[0]);
    });

    it('an anchor refused for want of quorum is a record, not just a stored verdict', async function () {
        verifyStub.returns(false);
        const data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ sections: [{ chain: 'BTC' }] }), data, null);

        assert.ok(String(data['STATUS']).startsWith('invalid:'), data['STATUS']);
        assert.strictEqual(failures().length, 1);
        assert.ok(failures()[0].includes('chain=BTC'), failures()[0]);
    });
});

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// ANCHOR v0, the per-network checkpoint bundle: section parsing, the per-section
// quorum, and the whole-bundle verdict when one section is bad. Part of the
// ANCHOR suite; see ../anchor.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const { createBaseData } = require('../../../../fixtures/mocks');
const { PUBKEY_A, PUBKEY_B, PUBKEY_C, PUBKEY_D, SIG, HASH, v0Params, THREE_CHAINS, PUBLISHER, armAnchor, disarmAnchor } = require('./helpers/anchor_fixtures.js');
const Anchor = require('../../../../../src/actions/anchor/index.js');
const eq = require('../../../../../src/consensus/equivocation_header.js');

let indexer, handler, verifyStub, swqStub, deriveGateStub;

function writtenRows() { return indexer.indexerDb.createAnchorAction.getCalls().map(c => c.args[0]); }

describe('Anchor (ANCHOR) @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
    });
    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    // ── v0: the per-network checkpoint bundle ────────────────────────────────────────
    it('v0 with a quorum of valid oracle_publish sigs is valid and stores one row per section', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ sections: THREE_CHAINS }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        let rows = writtenRows();
        assert.strictEqual(rows.length, 3, 'three chains, three rows, ONE action');
        assert.deepStrictEqual(rows.map(r => r['CHAIN']), ['BTC', 'DOGE', 'LTC']);
        assert.deepStrictEqual(rows.map(r => Number(r['SECTION_INDEX'])), [0, 1, 2]);
        assert.deepStrictEqual(rows.map(r => String(r['BLOCK_INDEX_CHECKPOINTED'])), ['500', '600', '700']);
        // Every row carries the header network and the bundle's publisher tail.
        for (let r of rows) {
            assert.strictEqual(r['NETWORK'], 'regtest');
            assert.strictEqual(r['PUBLISHER'], PUBKEY_A);
            assert.strictEqual(r['STATE_ROOT'], HASH('d'));
        }
        // The signed section canonical is the per-chain XCHECKPOINT + root suffix, rebuilt
        // with the HEADER network (the section's own network field is off the wire) and
        // EQUIV-wrapped (the regtest EQUIV header).
        let raw = ['XCHECKPOINT', 'BTC', 'regtest', '500', HASH('0'), HASH('1'), HASH('2'), HASH('3'), '0', '100',
                   HASH('d'), '1', HASH('e'), '1'].join('|');
        let expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, 'BTC|regtest|500|0', 0, raw);
        assert.strictEqual(verifyStub.firstCall.args[0], expected);
    });

    it('v0 rejects a malformed STATE_ROOT, naming the section', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ sections: [{ chain: 'BTC' }, { chain: 'LTC', state_root: 'nothex' }] }), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: SECTION 1 STATE_ROOT (format)');
    });

    it('v0 rejects a rootless section: the bundle is root-bearing by construction', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ sections: [{ chain: 'BTC', block_merkle_root: '' }] }), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: SECTION 0 BLOCK_MERKLE_ROOT (format)');
    });

    it('v0 rejects a header SNAPSHOT_BLOCK that is not the section maximum', async function () {
        // The bundle block is the MAX over sections, because it is where the election
        // and the attestation resolve. A higher header would move the attestation round
        // onto a set no section signature is bound to.
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ snapshot: '200', sections: [{ chain: 'BTC', snapshot: '100' }] }), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: SNAPSHOT_BLOCK (not the section maximum)');
    });
});

describe('Anchor (ANCHOR) @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
    });
    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    it('v0 accepts a lagging section riding at its OWN snapshot block (D6)', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({
            snapshot: '100',
            sections: [{ chain: 'BTC', snapshot: '100' }, { chain: 'LTC', snapshot: '94', seq: '0' }]
        }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.deepStrictEqual(writtenRows().map(r => String(r['SNAPSHOT_BLOCK'])), ['100', '94'],
            'each section row keeps its own snapshot block, never the bundle MAX');
    });

    it('rejects ANCHOR on a non-DOGE chain', async function () {
        indexer.config['COIN'] = 'BTC';
        handler = new Anchor(indexer);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0 });
        await handler.parse(v0Params(), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: ANCHOR only valid on DOGE'));
    });

    it('rejects a bundle for a different network', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ network: 'mainnet' }), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: NETWORK'));
    });

    it('enforces 2f+1 per section: 2 valid sigs of a 4-validator set (quorum 3) is rejected', async function () {
        indexer.indexerDb.getValidatorsByCapability.resolves(
            [PUBKEY_A, PUBKEY_B, PUBKEY_C, PUBKEY_D].map(pk => ({ pubkey: pk, amount: '1' })));
        verifyStub.callsFake((canon, sig, pk) => (pk === PUBKEY_A || pk === PUBKEY_B));
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({
            sections: [{ chain: 'BTC', sigs: [[PUBKEY_A, SIG], [PUBKEY_B, SIG], [PUBKEY_C, SIG]] }]
        }), data, null);
        // Message denominator is N (total snapshot validators), not the quorum;
        // 2 valid signatures of a 4-validator set (quorum 3) -> rejected.
        assert.strictEqual(data['STATUS'], 'invalid: SECTION 0 insufficient valid signatures (2/4)');
    });
});

describe('Anchor (ANCHOR) @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
    });
    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    it('a garbage-then-valid duplicate for one signer still passes (seen marked AFTER verify; hub/SDK/explorer/sync parity)', async function () {
        // N=2 validators -> quorum 2, so BOTH A and B must count. The wire sig list is
        // attacker-influenceable: prepend an INVALID entry for B before its genuine one.
        // Marking "seen" on first encounter (the pre-fix order) would suppress B's real
        // signature and reject a legitimately-quorate section (order-dependent under-count),
        // disagreeing with the hub finalizer + SDK/explorer/sync verifiers on the same bytes.
        indexer.indexerDb.getValidatorsByCapability.resolves(
            [PUBKEY_A, PUBKEY_B].map(pk => ({ pubkey: pk, amount: '1' })));
        const BADSIG = '0'.repeat(128);
        verifyStub.callsFake((canon, sig, pk) => sig === SIG);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({
            sections: [{ chain: 'BTC', sigs: [[PUBKEY_A, SIG], [PUBKEY_B, BADSIG], [PUBKEY_B, SIG]] }]
        }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('stores as unverified when no oracle_publish snapshot is mirrored locally', async function () {
        indexer.indexerDb.getValidatorsByCapability.resolves([]);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ sections: THREE_CHAINS }), data, null);
        assert.strictEqual(data['STATUS'], 'unverified');
        assert.strictEqual(writtenRows().length, 3);                  // stored regardless
        assert.ok(writtenRows().every(r => r['STATUS'] === 'unverified'),
            'the verdict is one column on N rows: never a mix');
    });

    // ── one bad section takes the whole bundle down, with zero rewards ──────────
    it('AT7: one STALE section invalidates the WHOLE bundle and writes no reward', async function () {
        // The chain-scoped watermark says every chain is already anchored at seq 5. BTC and
        // DOGE re-broadcast at 5 (equal is tolerated), LTC arrives at 4, which the hub's
        // selector can never emit: it is a replay or a forgery.
        indexer.indexerDb.getMaxAnchorCheckpointSeq.resolves(5);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({
            sections: [{ chain: 'BTC', block_index: '500', seq: '5' },
                       { chain: 'DOGE', block_index: '600', seq: '5' },
                       { chain: 'LTC', block_index: '700', seq: '4' }]
        }), data, null);
        assert.strictEqual(data['STATUS'],
            'invalid: SECTION 2 CHECKPOINT_SEQ (stale; replay of an older checkpoint)');
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled,
            'a bundle with a bad section pays nothing, not even for its good sections');
        assert.ok(indexer.indexerDb.reconcileAnchorRewardWinner.notCalled);
        let rows = writtenRows();
        assert.strictEqual(rows.length, 3, 'every section is still recorded on chain');
        assert.ok(rows.every(r => r['STATUS'] === data['STATUS']),
            'the verdict is all-or-nothing: no section row is left valid');
    });
});

describe('Anchor (ANCHOR) @regression @tier3', function () {
    beforeEach(function () {
        ({ indexer, handler, verifyStub, swqStub, deriveGateStub } = armAnchor());
    });
    afterEach(function () {
        disarmAnchor({ verifyStub, swqStub, deriveGateStub });
    });

    it('D39: two sections naming the same CHAIN invalidate the WHOLE bundle and write no reward', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({
            sections: [{ chain: 'BTC', block_index: '500' },
                       { chain: 'LTC', block_index: '700' },
                       { chain: 'BTC', block_index: '501' }]
        }), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: SECTION 2 CHAIN (duplicate)');
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
        assert.ok(indexer.indexerDb.reconcileAnchorRewardWinner.notCalled);
        assert.ok(writtenRows().every(r => r['STATUS'] === data['STATUS']),
            'no section row survives a duplicate-chain bundle as valid');
    });

    it('D39: the duplicate is named by the LATER section, not the first claim', async function () {
        // The reason has to point at the section that repeats, or an operator reading the
        // status goes looking at the legitimate first claim.
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({
            sections: [{ chain: 'DOGE' }, { chain: 'DOGE' }]
        }), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: SECTION 1 CHAIN (duplicate)');
    });

    it('D39: three DISTINCT chains are unaffected by the guard', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ sections: THREE_CHAINS }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(writtenRows().length, 3);
    });

    it('an EQUAL section seq is tolerated (a signature-bound re-broadcast, not a replay)', async function () {
        indexer.indexerDb.getMaxAnchorCheckpointSeq.resolves(5);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 0, COIN: 'DOGE' });
        await handler.parse(v0Params({ sections: [{ chain: 'BTC', seq: '5' }] }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });
});

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const zlib   = require('zlib');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Anchor  = require('../../../src/actions/anchor.js');
// Same module instance Anchor holds a reference to (Node module cache); stubbing
// `verify` here controls signature acceptance inside the handler.
const ed25519 = require('../../../src/ed25519.js');
const swq     = require('../../../src/stake_weighted_quorum.js');
const eq      = require('../../../src/equivocation_header.js');
const arMod   = require('../../../src/anchor_reward_activation.js');

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const PUBKEY_C = 'c'.repeat(64);
const PUBKEY_D = 'd'.repeat(64);
const SIG      = '1'.repeat(128);

const HASH = (c) => c.repeat(64);

function crc32Hex(str) {
    let buf = Buffer.from(str, 'utf8');
    let n;
    if (zlib.crc32) n = zlib.crc32(buf);
    else {
        let c, crc = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) {
            c = (crc ^ buf[i]) & 0xFF;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            crc = (crc >>> 8) ^ c;
        }
        n = (crc ^ 0xFFFFFFFF) >>> 0;
    }
    return (n >>> 0).toString(16).padStart(8, '0');
}
function gz64(str) { return zlib.gzipSync(Buffer.from(str, 'utf8'), { level: 9 }).toString('base64url'); }

// ANCHOR v7 params (the per-network checkpoint bundle; params[0] = VERSION, mirroring how
// actions.js splits the wire string): header, SECTION_COUNT sections in wire order, then
// ONE publisher tail for the whole bundle. `section_count` overrides the declared count
// independently of the sections actually emitted, so a lying header can be exercised.
function v7Params(overrides = {}) {
    let f = Object.assign({
        network: 'regtest', snapshot: '100',
        sections: [{ chain: 'BTC' }],
        publisher: PUBKEY_A, attest: [[PUBKEY_A, SIG]],
        section_count: null
    }, overrides);
    let sections = f.sections.map(s => Object.assign({
        chain: 'BTC', block_index: '500', block_hash: HASH('0'),
        ledger: HASH('1'), actions: HASH('2'), contracts: HASH('3'),
        seq: '0', snapshot: f.snapshot,
        state_root: HASH('d'), state_root_version: '1',
        block_merkle_root: HASH('e'), block_merkle_version: '1',
        sigs: [[PUBKEY_A, SIG]]
    }, s));
    let p = ['7', f.network, f.snapshot,
             String(f.section_count !== null ? f.section_count : sections.length)];
    for (let s of sections) {
        p.push(s.chain, s.block_index, s.block_hash, s.ledger, s.actions, s.contracts,
               s.seq, s.snapshot, s.state_root, s.state_root_version,
               s.block_merkle_root, s.block_merkle_version, String(s.sigs.length));
        for (let [pk, sg] of s.sigs) p.push(pk, sg);
    }
    p.push(f.publisher, String(f.attest.length));
    for (let [pk, sg] of f.attest) p.push(pk, sg);
    return p;
}

// A three-chain bundle in wire order (sections CHAIN ascending, D5): the AT1 shape.
const THREE_CHAINS = [{ chain: 'BTC',  block_index: '500' },
                      { chain: 'DOGE', block_index: '600' },
                      { chain: 'LTC',  block_index: '700' }];

function v1Params(archiveJson, overrides = {}) {
    let b64 = (overrides.archive_b64 !== undefined) ? overrides.archive_b64 : gz64(archiveJson);
    let f = Object.assign({
        chain: 'BTC', network: 'regtest', block_index: '500', block_hash: HASH('0'),
        ledger: HASH('1'), actions: HASH('2'), contracts: HASH('3'),
        seq: '0', snapshot: '100',
        batch_seq: '0', match_count: '1',
        crc: crc32Hex(archiveJson), total_chunks: '1',
        sigs: [[PUBKEY_A, SIG]]
    }, overrides);
    let p = ['1', f.chain, f.network, f.block_index, f.block_hash, f.ledger, f.actions, f.contracts,
             f.seq, f.snapshot, f.batch_seq, f.match_count, f.crc, f.total_chunks, b64, String(f.sigs.length)];
    for (let [pk, sg] of f.sigs) p.push(pk, sg);
    return p;
}




// ANCHOR v6 params (archive-reward): v1 fields + the wrapper sig list, then the
// PUBLISHER pubkey + the attestation sig list appended at the tail.
function v6Params(archiveJson, overrides = {}) {
    let b64 = (overrides.archive_b64 !== undefined) ? overrides.archive_b64 : gz64(archiveJson);
    let f = Object.assign({
        chain: 'BTC', network: 'regtest', block_index: '500', block_hash: HASH('0'),
        ledger: HASH('1'), actions: HASH('2'), contracts: HASH('3'),
        seq: '0', snapshot: '100',
        batch_seq: '0', match_count: '1',
        crc: crc32Hex(archiveJson), total_chunks: '1',
        sigs: [[PUBKEY_A, SIG]],
        publisher: PUBKEY_A, attest: [[PUBKEY_A, SIG]]
    }, overrides);
    let p = ['6', f.chain, f.network, f.block_index, f.block_hash, f.ledger, f.actions, f.contracts,
             f.seq, f.snapshot, f.batch_seq, f.match_count, f.crc, f.total_chunks, b64, String(f.sigs.length)];
    for (let [pk, sg] of f.sigs) p.push(pk, sg);
    p.push(f.publisher, String(f.attest.length));
    for (let [pk, sg] of f.attest) p.push(pk, sg);
    return p;
}

const ARCHIVE_JSON = JSON.stringify({ v: 1, network: 'regtest', batch_seq: 0, matches: [{ match_id: 'm1' }], capability_snapshots: [] });

// The archive head's AUTHOR address (#3075), i.e. what db.getAnchorV1ByBatchSeq now
// returns as `source`. Deliberately createBaseData's SOURCE: a v2 continuation chunk is
// authenticated by matching it, so every legitimate-chunk fixture below publishes as this
// address and the hostile ones publish as OUTSIDER.
const PUBLISHER = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const OUTSIDER  = 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef';

describe('Anchor (ANCHOR) @regression @tier3', function () {
    let indexer, handler, verifyStub, swqStub, deriveGateStub;

    function addAnchorDbStubs(db) {
        db.getValidatorsByCapability  = sinon.stub().resolves([{ pubkey: PUBKEY_A, amount: '1' }]);
        db.hasCapability              = sinon.stub().resolves(true);
        db.getMaxAnchorCheckpointSeq  = sinon.stub().resolves(null);
        db.getArchiveReplayWatermarks = sinon.stub().resolves({ batchSeq: null, checkpointSeq: null });
        db.createAnchorAction         = sinon.stub().resolves();
        db.getAnchorV1ByBatchSeq      = sinon.stub().resolves(null);
        db.getAnchorChunks            = sinon.stub().resolves([]);
        db.setAnchorArchiveStatus     = sinon.stub().resolves();
        db.createValidatorReward      = sinon.stub().resolves(true);
        db.reconcileAnchorRewardWinner= sinon.stub().resolves(0);
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: 'regtest' });
        addAnchorDbStubs(indexer.indexerDb);
        handler = new Anchor(indexer);
        verifyStub = sinon.stub(ed25519, 'verify').returns(true);
        // These cases assert legacy COUNT quorum (the live mainnet path, whose
        // activation is a far-future placeholder). Regtest has WI-1 stake-weighted
        // quorum active at every block, so pin the legacy path: the oracle_publish
        // mocks here carry no source/weight. Weighted coverage: StakeWeightedQuorum.test.js.
        swqStub = sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        // these cases assert the LEGACY DOGE-side reward derivation (still the
        // behavior below the derive-relocation flag-day / on mainnet, where the gate is an
        // inert placeholder). Pin the derive gate OFF so anchor.js runs the DOGE-side write;
        // the at/above-gate skip + BTC-side relocation are covered by anchorRewardDerive.test.js
        // and the dedicated 'derive-relocation flag-day' describe below.
        deriveGateStub = sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(false);
    });
    afterEach(function () { verifyStub.restore(); swqStub.restore(); deriveGateStub.restore(); });

    function lastWrite() { return indexer.indexerDb.createAnchorAction.lastCall.args[0]; }

    function writtenRows() { return indexer.indexerDb.createAnchorAction.getCalls().map(c => c.args[0]); }

    // ── v7: the per-network checkpoint bundle ────────────────────────────────────────
    it('v7 with a quorum of valid oracle_publish sigs is valid and stores one row per section', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({ sections: THREE_CHAINS }), data, null);
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
        // EQUIV-wrapped (regtest, WI-2 bump 2).
        let raw = ['XCHECKPOINT', 'BTC', 'regtest', '500', HASH('0'), HASH('1'), HASH('2'), HASH('3'), '0', '100',
                   HASH('d'), '1', HASH('e'), '1'].join('|');
        let expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, 'BTC|regtest|500|0', 0, raw);
        assert.strictEqual(verifyStub.firstCall.args[0], expected);
    });

    it('v7 rejects a malformed STATE_ROOT, naming the section', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({ sections: [{ chain: 'BTC' }, { chain: 'LTC', state_root: 'nothex' }] }), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: SECTION 1 STATE_ROOT (format)');
    });

    it('v7 rejects a rootless section: the bundle is root-bearing by construction', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({ sections: [{ chain: 'BTC', block_merkle_root: '' }] }), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: SECTION 0 BLOCK_MERKLE_ROOT (format)');
    });

    it('v7 rejects a header SNAPSHOT_BLOCK that is not the section maximum', async function () {
        // D6: the bundle block is the MAX over sections, because it is where the election
        // and the attestation resolve. A higher header would move the attestation round
        // onto a set no section signature is bound to.
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({ snapshot: '200', sections: [{ chain: 'BTC', snapshot: '100' }] }), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: SNAPSHOT_BLOCK (not the section maximum)');
    });

    it('v7 accepts a lagging section riding at its OWN snapshot block (D6)', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({
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
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7 });
        await handler.parse(v7Params(), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: ANCHOR only valid on DOGE'));
    });

    it('rejects a bundle for a different network', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({ network: 'mainnet' }), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: NETWORK'));
    });

    it('enforces 2f+1 per section: 2 valid sigs of a 4-validator set (quorum 3) is rejected', async function () {
        indexer.indexerDb.getValidatorsByCapability.resolves(
            [PUBKEY_A, PUBKEY_B, PUBKEY_C, PUBKEY_D].map(pk => ({ pubkey: pk, amount: '1' })));
        verifyStub.callsFake((canon, sig, pk) => (pk === PUBKEY_A || pk === PUBKEY_B));
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({
            sections: [{ chain: 'BTC', sigs: [[PUBKEY_A, SIG], [PUBKEY_B, SIG], [PUBKEY_C, SIG]] }]
        }), data, null);
        // Message denominator is N (total snapshot validators), not the quorum;
        // 2 valid signatures of a 4-validator set (quorum 3) -> rejected.
        assert.strictEqual(data['STATUS'], 'invalid: SECTION 0 insufficient valid signatures (2/4)');
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
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({
            sections: [{ chain: 'BTC', sigs: [[PUBKEY_A, SIG], [PUBKEY_B, BADSIG], [PUBKEY_B, SIG]] }]
        }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('stores as unverified when no oracle_publish snapshot is mirrored locally', async function () {
        indexer.indexerDb.getValidatorsByCapability.resolves([]);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({ sections: THREE_CHAINS }), data, null);
        assert.strictEqual(data['STATUS'], 'unverified');
        assert.strictEqual(writtenRows().length, 3);                  // stored regardless
        assert.ok(writtenRows().every(r => r['STATUS'] === 'unverified'),
            'the verdict is one column on N rows: never a mix');
    });

    // ── AT7: one bad section takes the whole bundle down, with zero rewards ──────────
    it('AT7: one STALE section invalidates the WHOLE bundle and writes no reward', async function () {
        // The chain-scoped watermark says every chain is already anchored at seq 5. BTC and
        // DOGE re-broadcast at 5 (equal is tolerated), LTC arrives at 4, which the hub's
        // selector can never emit: it is a replay or a forgery.
        indexer.indexerDb.getMaxAnchorCheckpointSeq.resolves(5);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({
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

    it('D39: two sections naming the same CHAIN invalidate the WHOLE bundle and write no reward', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({
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
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({
            sections: [{ chain: 'DOGE' }, { chain: 'DOGE' }]
        }), data, null);
        assert.strictEqual(data['STATUS'], 'invalid: SECTION 1 CHAIN (duplicate)');
    });

    it('D39: three DISTINCT chains are unaffected by the guard', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({ sections: THREE_CHAINS }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(writtenRows().length, 3);
    });

    it('an EQUAL section seq is tolerated (a signature-bound re-broadcast, not a replay)', async function () {
        indexer.indexerDb.getMaxAnchorCheckpointSeq.resolves(5);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({ sections: [{ chain: 'BTC', seq: '5' }] }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    // ── the bundle reward ────────────────────────────────────────────────────────────
    it('v7 with a valid publisher attestation DERIVES exactly ONE anchor_bundle reward', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({ sections: THREE_CHAINS }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(data['PUBLISHER'], PUBKEY_A);
        assert.ok(indexer.indexerDb.createValidatorReward.calledOnce,
            'ONE reward per bundle, not one per section');
        // (pubkeyHex, roundReference, rewardType, amount, blockIndex, upsert,
        // deriveBlockIndex, roundQualifier) - frozen amount, NOT wire. round_reference is
        // SNAPSHOT_BLOCK, a height that only advances, so the qualifier stays 0.
        assert.deepStrictEqual(indexer.indexerDb.createValidatorReward.firstCall.args,
            [PUBKEY_A, 100, 'anchor_bundle', '10.00000000', 100, true, null, 0]);
        assert.ok(indexer.indexerDb.reconcileAnchorRewardWinner.calledOnceWith(100, 'anchor_bundle'));
    });

    it('at/above the derive-relocation gate the DOGE-side write is SKIPPED (relocated to BTC), bundle still valid', async function () {
        deriveGateStub.returns(true);                                   // derive relocated to the BTC indexer
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({ sections: THREE_CHAINS }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');                    // attestation verification unaffected
        assert.strictEqual(data['PUBLISHER'], PUBKEY_A);
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled, 'DOGE no longer writes the reward at/above the gate');
        assert.ok(indexer.indexerDb.reconcileAnchorRewardWinner.notCalled);
        assert.strictEqual(writtenRows().length, 3);                    // the sections are still recorded
    });

    it('v7 keeps the bundle valid but SKIPS the reward when PUBLISHER is not in the oracle_publish set', async function () {
        // Snapshot = {A}; attestation quorum from A is valid, but the named PUBLISHER is B.
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({ publisher: PUBKEY_B }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');                 // the anchor still lands
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled); // reward denied
    });

    it('v7 keeps the bundle valid but SKIPS the reward when the attestation quorum is short', async function () {
        // Snapshot = {A}; the only attestation sig is from B (not in the set) -> 0 valid attesters.
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({ attest: [[PUBKEY_B, SIG]] }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
    });

    it('v7 rejects a malformed PUBLISHER', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({ publisher: 'nothex' }), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: PUBLISHER format'));
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
    });

    it('bundle reward (XANCPUB) canonical: six positional fields with snapshot_block at index 3', function () {
        // D22: the layout keeps SIX fields, round_reference repeated as the snapshot block,
        // so slash.js's XANCPUB branch (index 3) judges a bundle equivocation with no third
        // case. A five-field draft would have made every bundle equivocation read
        // 'invalid: snapshot_block'.
        let d = { FORMAT: 7, NETWORK: 'regtest', SNAPSHOT_BLOCK: 100, PUBLISHER: PUBKEY_A };
        let raw = ['XANCPUB', 'anchor_bundle', '100', '100', PUBKEY_A, '10.00000000'].join('|');
        let expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, 'XANCPUB|bundle|regtest|100', 0, raw);
        assert.strictEqual(handler._rewardCanonical(d), expected);
        // The content slash.js reads sits after the '||' separator; field 3 is the block.
        assert.strictEqual(expected.split('||')[1].split('|')[3], '100');
    });

    it('determinism: two independent parses of identical v7 bytes derive the identical reward row', async function () {
        let h2 = new Anchor(indexer);
        let d1 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        let d2 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 7, COIN: 'DOGE' });
        await handler.parse(v7Params({ sections: THREE_CHAINS }), d1, null);
        let firstArgs = indexer.indexerDb.createValidatorReward.lastCall.args;
        await h2.parse(v7Params({ sections: THREE_CHAINS }), d2, null);
        let secondArgs = indexer.indexerDb.createValidatorReward.lastCall.args;
        assert.deepStrictEqual(firstArgs, secondArgs);
    });

    it('the retired per-chain versions no longer parse at all (D2)', async function () {
        for (const v of [0, 3, 4, 5]) {
            let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: v, COIN: 'DOGE' });
            await handler.parse(['' + v, 'BTC', 'regtest'], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: VERSION (unknown)',
                'ANCHOR v' + v + ' is retired; its parser is deleted, not merely unused');
        }
    });

    // ── v6: archive publisher-attestation + anchor_archive reward derivation ──
    it('v6 with a valid publisher attestation is valid, stores the archive, and DERIVES the anchor_archive reward', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 6, COIN: 'DOGE' });
        await handler.parse(v6Params(ARCHIVE_JSON), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(data['PUBLISHER'], PUBKEY_A);
        assert.strictEqual(data['MATCH_BATCH_SEQ'], '0');
        assert.strictEqual(data['ARCHIVE_B64'], gz64(ARCHIVE_JSON));
        assert.ok(indexer.indexerDb.createValidatorReward.calledOnce);
        // (pubkeyHex, roundReference=MATCH_BATCH_SEQ, rewardType, amount, blockIndex, upsert,
        // deriveBlockIndex, roundQualifier) - frozen ARCHIVE amount, NOT wire. The archive leg
        // IS qualified: MATCH_BATCH_SEQ is a dense hub counter a wipe-and-replay rebase
        // reissues, so SNAPSHOT_BLOCK (100 here, the same height block_index carries) is what
        // keeps two genuinely distinct archive anchors from collapsing onto one reward row.
        assert.deepStrictEqual(indexer.indexerDb.createValidatorReward.firstCall.args,
            [PUBKEY_A, 0, 'anchor_archive', '10.00000000', 100, true, null, 100]);
        assert.ok(indexer.indexerDb.reconcileAnchorRewardWinner.calledOnceWith(0, 'anchor_archive'));
    });

    it('v6 wrapper sigs verify over the UNCHANGED v1 archive canonical (batch-extended, EQUIV-wrapped)', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 6, COIN: 'DOGE' });
        await handler.parse(v6Params(ARCHIVE_JSON), data, null);
        let raw = ['XCHECKPOINT', 'BTC', 'regtest', '500', HASH('0'), HASH('1'), HASH('2'), HASH('3'), '0', '100'].join('|') +
                  '|0|1|' + crc32Hex(ARCHIVE_JSON) + '|1';
        let expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, 'BTC|regtest|500|0|0', 0, raw);
        assert.strictEqual(verifyStub.firstCall.args[0], expected);
    });

    it('v6 is rejected before the ARCHIVE_REWARD flag-day', async function () {
        let arStub = sinon.stub(require('../../../src/anchor_reward_activation.js'),
            'isArchiveRewardActive').returns(false);
        try {
            let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 6, COIN: 'DOGE' });
            await handler.parse(v6Params(ARCHIVE_JSON), data, null);
            assert.ok(String(data['STATUS']).startsWith('invalid: ANCHOR v6 before ARCHIVE_REWARD flag-day'));
        } finally { arStub.restore(); }
    });

    it('v6 keeps the anchor valid but SKIPS the reward when PUBLISHER is not in the oracle_publish set', async function () {
        // Snapshot = {A}; attestation quorum from A is valid, but the named PUBLISHER is B.
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 6, COIN: 'DOGE' });
        await handler.parse(v6Params(ARCHIVE_JSON, { publisher: PUBKEY_B }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
    });

    it('v6 keeps the anchor valid but SKIPS the reward when the attestation quorum is short', async function () {
        // Snapshot = {A}; the only attestation sig is from B (not in the set) -> 0 valid attesters.
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 6, COIN: 'DOGE' });
        await handler.parse(v6Params(ARCHIVE_JSON, { attest: [[PUBKEY_B, SIG]] }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
    });

    it('v6 rejects a CRC mismatch exactly like v1 (archive integrity unchanged)', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 6, COIN: 'DOGE' });
        await handler.parse(v6Params(ARCHIVE_JSON, { crc: 'deadbeef' }), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: BATCH_CRC32'));
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
    });

    it('v6 archive reward (XANCPUB) canonical: XANCPUB|anchor_archive|batch|snapshot|publisher|amount with the archive round-id family', function () {
        let d = {
            FORMAT: 6, CHAIN: 'BTC', NETWORK: 'regtest', CHECKPOINT_SEQ: 0, SNAPSHOT_BLOCK: 100,
            MATCH_BATCH_SEQ: 3, PUBLISHER: PUBKEY_A
        };
        let raw = ['XANCPUB', 'anchor_archive', '3', '100', PUBKEY_A, '10.00000000'].join('|');
        let expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, 'XANCPUB|archive|regtest|3|100', 0, raw);
        assert.strictEqual(handler._rewardCanonical(d), expected);
    });

    it('v6 replay guard: a match_batch_seq below the recorded max is stale', async function () {
        // Both watermarks are behind-worthy: seq 2 < 3 AND the payload's checkpoint
        // seq (0) is behind the newest archive's (5). made the second half
        // load-bearing, so a fixture that only pinned the batch seq would now pass
        // for the wrong reason.
        indexer.indexerDb.getArchiveReplayWatermarks.resolves({ batchSeq: 3, checkpointSeq: 5 });
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 6, COIN: 'DOGE' });
        await handler.parse(v6Params(ARCHIVE_JSON, { batch_seq: '2' }), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: MATCH_BATCH_SEQ (stale'));
        assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
    });

    // The rebase resets the hub's dense batch-seq allocator
    // (StateAnchorPublisher._getNextBatchSeq counts its own tables) while this
    // watermark, read from replayed anchor_actions, returns to the pre-rebase max.
    // Both directions are pinned here because the two failures are opposite and
    // equally bad: reject the fresh batch and the archive rail is dead for as many
    // batches as history had; admit the old one and a stale archive can be replayed.
    it('v1 replay guard: a restarted batch seq is ACCEPTED when its wrapper checkpoint advances', async function () {
        indexer.indexerDb.getArchiveReplayWatermarks.resolves({ batchSeq: 40, checkpointSeq: 900000 });
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        // Post-rebase: the hub's counter restarted at 0, but checkpoint_seq is
        // snapshot_block and the chain kept moving.
        await handler.parse(v1Params(ARCHIVE_JSON, { batch_seq: '0', seq: '961000' }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('v1 replay guard: a stale batch seq with a stale checkpoint is still rejected', async function () {
        indexer.indexerDb.getArchiveReplayWatermarks.resolves({ batchSeq: 40, checkpointSeq: 900000 });
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        // A genuine replay is signature-bound to its original canonical, so it can
        // only carry the OLD checkpoint seq. That is what still catches it.
        await handler.parse(v1Params(ARCHIVE_JSON, { batch_seq: '12', seq: '880000' }), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: MATCH_BATCH_SEQ (stale'));
    });

    it('v1 replay guard: a second batch riding the SAME checkpoint is not treated as stale', async function () {
        indexer.indexerDb.getArchiveReplayWatermarks.resolves({ batchSeq: 40, checkpointSeq: 961000 });
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        // Equal, not ahead: one cadence can publish a second batch draining leftover
        // rows, and the guard elsewhere already treats an equal seq as the tolerated
        // duplicate case rather than a replay.
        await handler.parse(v1Params(ARCHIVE_JSON, { batch_seq: '2', seq: '961000' }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('v6 replay guard: the reward rail rides the same exemption, so a restarted batch still derives its reward', async function () {
        indexer.indexerDb.getArchiveReplayWatermarks.resolves({ batchSeq: 40, checkpointSeq: 900000 });
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 6, COIN: 'DOGE' });
        await handler.parse(v6Params(ARCHIVE_JSON, { batch_seq: '0', seq: '961000' }), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.createValidatorReward.called);
    });

    it('determinism: two independent parses of identical v6 bytes derive the identical archive reward row', async function () {
        let h2 = new Anchor(indexer);
        let d1 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 6, COIN: 'DOGE' });
        let d2 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 6, COIN: 'DOGE' });
        await handler.parse(v6Params(ARCHIVE_JSON), d1, null);
        let firstArgs = indexer.indexerDb.createValidatorReward.lastCall.args;
        await h2.parse(v6Params(ARCHIVE_JSON), d2, null);
        let secondArgs = indexer.indexerDb.createValidatorReward.lastCall.args;
        assert.deepStrictEqual(firstArgs, secondArgs);
    });

    it('replay guard: a checkpoint_seq below the recorded max is stale; equal is allowed (a v7 section and its v1 archive share a seq)', async function () {
        indexer.indexerDb.getMaxAnchorCheckpointSeq.resolves(5);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        await handler.parse(v1Params(ARCHIVE_JSON, { seq: '4' }), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: CHECKPOINT_SEQ (stale'));

        let data2 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', ACTION_INDEX: 2 });
        await handler.parse(v1Params(ARCHIVE_JSON, { seq: '5' }), data2, null);
        assert.strictEqual(data2['STATUS'], 'valid');
    });

    it('replay guard: a v1 match_batch_seq below the recorded max is stale', async function () {
        indexer.indexerDb.getArchiveReplayWatermarks.resolves({ batchSeq: 3, checkpointSeq: 5 });
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        await handler.parse(v1Params(ARCHIVE_JSON, { batch_seq: '2' }), data, null);
        assert.ok(String(data['STATUS']).startsWith('invalid: MATCH_BATCH_SEQ (stale'));
    });

    it('v1 single-chunk: CRC binds the archive, valid blob accepted, mismatch rejected', async function () {
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE' });
        await handler.parse(v1Params(ARCHIVE_JSON), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        // v1 canonical appends the archive fields. EQUIV active in regtest: the v1
        // ROUND_ID appends batch_seq (=0 here) to the v0 round id so v0 and v1 get
        // DISTINCT equivocation keys (R-4 false-slash fix); VIEW=0.
        let raw = ['XCHECKPOINT', 'BTC', 'regtest', '500', HASH('0'), HASH('1'), HASH('2'), HASH('3'), '0', '100',
                        '0', '1', crc32Hex(ARCHIVE_JSON), '1'].join('|');
        let expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, 'BTC|regtest|500|0|0', 0, raw);
        assert.strictEqual(verifyStub.firstCall.args[0], expected);

        let data2 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 1, COIN: 'DOGE', ACTION_INDEX: 2 });
        await handler.parse(v1Params(ARCHIVE_JSON, { crc: 'deadbeef' }), data2, null);
        assert.ok(String(data2['STATUS']).startsWith('invalid: BATCH_CRC32 (archive mismatch)'));
    });

    it('v2 continuation stores, orphans without a parent v1, and rejects duplicates', async function () {
        // Orphan: no parent v1 for batch 9
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE' });
        await handler.parse(['2', '9', '1', '3', gz64('x')], data, null);
        assert.strictEqual(data['STATUS'], 'orphan');

        // Parent present, fresh chunk from the head's OWN publisher → valid. `source` is
        // the head author the chunk is bound to (#3075); createBaseData's SOURCE is the
        // chunk author, so the two must match for the chunk to be authenticated at all.
        indexer.indexerDb.getAnchorV1ByBatchSeq.resolves({ action_index: 1, total_chunks: 3, archive_b64: 'AAA', batch_crc32: 'deadbeef', source: PUBLISHER });
        let data2 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 3 });
        await handler.parse(['2', '9', '1', '3', 'BBBB'], data2, null);
        assert.strictEqual(data2['STATUS'], 'valid');

        // Duplicate chunk index → invalid
        indexer.indexerDb.getAnchorChunks.resolves([{ chunk_index: 1, archive_b64: 'BBBB' }]);
        let data3 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 4 });
        await handler.parse(['2', '9', '1', '3', 'BBBB'], data3, null);
        assert.ok(String(data3['STATUS']).startsWith('invalid: CHUNK_INDEX (duplicate)'));
    });

    // ── #3075: chunk-slot poisoning. "Authenticated by its parent v1" used to mean only
    //    that a parent existed with matching geometry, so the FIRST broadcast into a slot
    //    won permanently: a junk chunk took the slot, the real publisher's chunk was
    //    rejected as a duplicate, and the batch could never reassemble. ─────────────────
    describe('v2 chunk authorship (#3075)', function () {

        const headOf = (source) => ({ action_index: 1, total_chunks: 3, archive_b64: 'AAA', batch_crc32: 'deadbeef', source });

        it('rejects a chunk whose author is not the archive head publisher', async function () {
            indexer.indexerDb.getAnchorV1ByBatchSeq.resolves(headOf(PUBLISHER));
            let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 7, SOURCE: OUTSIDER });
            await handler.parse(['2', '9', '1', '3', 'BBBB'], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: SOURCE (not the archive head publisher)');
        });

        it('the real publisher keeps its slot: an outsider chunk no longer makes it a duplicate', async function () {
            // The denial the finding describes, driven end to end. The junk chunk is
            // rejected on authorship, so it is NOT in the occupancy set getAnchorChunks
            // returns (that query excludes 'invalid: ...' rows), and the legitimate chunk
            // for the same index parses 'valid' instead of 'invalid: CHUNK_INDEX (duplicate)'.
            indexer.indexerDb.getAnchorV1ByBatchSeq.resolves(headOf(PUBLISHER));
            let junk = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 8, SOURCE: OUTSIDER });
            await handler.parse(['2', '9', '1', '3', 'JUNK'], junk, null);
            assert.ok(String(junk['STATUS']).startsWith('invalid: SOURCE'));

            let real = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 9, SOURCE: PUBLISHER });
            await handler.parse(['2', '9', '1', '3', 'BBBB'], real, null);
            assert.strictEqual(real['STATUS'], 'valid');
        });

        it('fails closed when the head author cannot be resolved at all', async function () {
            // A head whose actions/index_addresses linkage is missing yields source null.
            // Waving the chunk through then would authenticate it against nothing.
            indexer.indexerDb.getAnchorV1ByBatchSeq.resolves(headOf(null));
            let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 10 });
            await handler.parse(['2', '9', '1', '3', 'BBBB'], data, null);
            assert.strictEqual(data['STATUS'], 'invalid: SOURCE (archive head author unresolvable)');
        });

        it('geometry still outranks authorship, so the pre-#3075 verdict is unchanged', async function () {
            // TOTAL_CHUNKS is checked first: a wrong-geometry chunk from the right
            // publisher must keep reporting the geometry reason, not the new one.
            indexer.indexerDb.getAnchorV1ByBatchSeq.resolves(headOf(PUBLISHER));
            let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 11 });
            await handler.parse(['2', '9', '1', '4', 'BBBB'], data, null);
            assert.ok(String(data['STATUS']).startsWith('invalid: TOTAL_CHUNKS'));
        });

        it('an orphan chunk is still stored unjudged: there is no head to authenticate against', async function () {
            // Legitimate early chunks exist (the head can land last), so an
            // orphan must NOT be rejected on authorship. Excluding a junk orphan is the
            // read path's job (ARCHIVE_CHUNK_SET_SQL), not this one's.
            indexer.indexerDb.getAnchorV1ByBatchSeq.resolves(null);
            let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 12, SOURCE: OUTSIDER });
            await handler.parse(['2', '9', '1', '3', 'BBBB'], data, null);
            assert.strictEqual(data['STATUS'], 'orphan');
        });
    });

    it('v2 reassembly: the final chunk triggers CRC verification and flags a bad batch', async function () {
        let json = ARCHIVE_JSON;
        let b64  = gz64(json);
        let cut1 = Math.ceil(b64.length / 3), cut2 = 2 * cut1;
        let parent = { action_index: 1, total_chunks: 3, archive_b64: b64.slice(0, cut1), batch_crc32: crc32Hex(json), source: PUBLISHER };
        indexer.indexerDb.getAnchorV1ByBatchSeq.resolves(parent);
        // First call per parse = duplicate guard (before this chunk is stored);
        // second call = reassembly read (after the store).
        let chunk1 = { chunk_index: 1, archive_b64: b64.slice(cut1, cut2) };
        let chunk2 = { chunk_index: 2, archive_b64: b64.slice(cut2) };
        let calls = 0;
        indexer.indexerDb.getAnchorChunks.callsFake(async () => (++calls % 2 === 1) ? [chunk1] : [chunk1, chunk2]);
        let data = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 5 });
        await handler.parse(['2', '9', '2', '3', b64.slice(cut2)], data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.setAnchorArchiveStatus.notCalled);        // CRC matched: no flag

        // Same reassembly with a corrupted parent CRC → batch flagged invalid_archive
        parent.batch_crc32 = '00000000';
        let data2 = createBaseData({ ACTION: 'ANCHOR', FORMAT: 2, COIN: 'DOGE', ACTION_INDEX: 6 });
        await handler.parse(['2', '9', '2', '3', b64.slice(cut2)], data2, null);
        assert.ok(indexer.indexerDb.setAnchorArchiveStatus.calledWith(1, 'invalid_archive'));
    });
});

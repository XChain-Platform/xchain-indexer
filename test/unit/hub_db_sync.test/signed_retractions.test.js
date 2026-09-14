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
const sinon = require('sinon');

const HubDbSync = require('../../../src/hub/hub_db_sync.js');

// Build a HubDbSync whose enabled flag is true (needs both a hub URL and a hub DB),
// backed by a stubbed doQuery we drive per-test to simulate the local price mirror.
function makeSync(maxReferenceBlock) {
    const doQuery = sinon.stub();
    doQuery.callsFake(async () => [{ h: maxReferenceBlock }]);
    const hubDb = { doQuery };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test' });
    return { sync, hubDb, doQuery };
}

const nodeCrypto = require('crypto');
const GOLDEN_CANONICAL = 'XRETRACTV1|cross_chain_calls|DOGE|42|99|7|5000';
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function makeSigner() {
    const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
    const pubkeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length).toString('hex');
    return {
        pubkey: pubkeyHex.toLowerCase(),
        sign: (payload) => nodeCrypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex')
    };
}

// Mirror stub: routes the gate high-water query, the per-block snapshot
// membership query, and captures DELETEs. `snapRows` = mirrored
// capability_snapshots at snapshot_block 5000 (source-keyed: SWQ is
// genesis-active on regtest, so the weighted 3*tally > 2*S predicate runs).
function makeSigned({ snapRows, maxSnapshotBlock = 5000, network = 'regtest' } = {}) {
    const deletes = [];
    const doQuery = sinon.stub().callsFake(async (sql, args) => {
        if (/MAX\(snapshot_block\)/.test(sql)) return [{ sb: maxSnapshotBlock }];
        if (/SELECT signing_pubkey/.test(sql)) return snapRows || [];
        if (/^DELETE/.test(sql)) { deletes.push({ sql, args }); return []; }
        return [];
    });
    const sync = new HubDbSync({ doQuery }, network ? { hubUrl: 'http://hub.test', network } : { hubUrl: 'http://hub.test' });
    return { sync, deletes };
}

function signedEvent(sigs, overrides) {
    return Object.assign({
        table: 'cross_chain_calls', source_chain: 'DOGE',
        from_action_index: 42, to_action_index: 99,
        retraction_generation: 7, snapshot_block: 5000,
        retraction_signatures: sigs
    }, overrides || {});
}

// ---------------------------------------------------------------------------
// Full fix: signed quorum-class retractions. Once this mirror's own
// capability_snapshots high-water mark crosses the RETRACTION_SIGNING era
// (regtest: genesis), a cross_chain_calls / cross_chain_matches deletion must
// carry a 2f+1 `cross_chain` co-signature set over the XRETRACTV1 canonical,
// verified against the mirrored snapshot at the event's snapshot_block.
// The canonical here is the GOLDEN literal pinned byte-for-byte by the hub's
// RetractionConsensus.test.js: a signature minted over the literal must verify
// against this module's independent rebuild, proving producer/consumer parity.
// ---------------------------------------------------------------------------
describe('HubDbSync._applyRetraction signed retractions @regression @tier1', function () {
    it('REFUSES an unsigned quorum-class retraction once the local snapshot era passes the gate', async function () {
        const s = makeSigner();
        const { sync, deletes } = makeSigned({ snapRows: [{ signing_pubkey: s.pubkey, amount: '100', source: 'srcA' }] });
        const evt = signedEvent(undefined);
        delete evt.retraction_signatures;
        delete evt.snapshot_block;
        await sync._applyRetraction(evt);
        assert.strictEqual(deletes.length, 0, 'unsigned quorum-class deletion must not run past the gate');
    });

    it('APPLIES a correctly signed retraction (1-of-1 snapshot), proving canonical parity with the hub', async function () {
        const s = makeSigner();
        const { sync, deletes } = makeSigned({ snapRows: [{ signing_pubkey: s.pubkey, amount: '100', source: 'srcA' }] });
        await sync._applyRetraction(signedEvent([{ pubkey: s.pubkey, sig: s.sign(GOLDEN_CANONICAL) }]));
        assert.strictEqual(deletes.length, 1, 'a valid quorum-signed retraction must apply');
        assert.match(deletes[0].sql, /DELETE FROM cross_chain_calls/);
    });

    it('REFUSES when the wire generation is tampered after signing (fence is signature-bound)', async function () {
        const s = makeSigner();
        const { sync, deletes } = makeSigned({ snapRows: [{ signing_pubkey: s.pubkey, amount: '100', source: 'srcA' }] });
        await sync._applyRetraction(signedEvent(
            [{ pubkey: s.pubkey, sig: s.sign(GOLDEN_CANONICAL) }],
            { retraction_generation: 999999 }));   // replay with an inflated fence
        assert.strictEqual(deletes.length, 0, 'an inflated-generation replay must fail signature verification');
    });

    it('REFUSES a signer outside the mirrored snapshot', async function () {
        const member = makeSigner(), stranger = makeSigner();
        const { sync, deletes } = makeSigned({ snapRows: [{ signing_pubkey: member.pubkey, amount: '100', source: 'srcA' }] });
        await sync._applyRetraction(signedEvent([{ pubkey: stranger.pubkey, sig: stranger.sign(GOLDEN_CANONICAL) }]));
        assert.strictEqual(deletes.length, 0);
    });

    it('enforces the weighted 2/3 bar: 2 of 4 equal sources refused, 3 of 4 applied', async function () {
        const signers = [makeSigner(), makeSigner(), makeSigner(), makeSigner()];
        const snapRows = signers.map((s, i) => ({ signing_pubkey: s.pubkey, amount: '100', source: 'src' + i }));
        const sigsOf = (n) => signers.slice(0, n).map(s => ({ pubkey: s.pubkey, sig: s.sign(GOLDEN_CANONICAL) }));
        {
            const { sync, deletes } = makeSigned({ snapRows });
            await sync._applyRetraction(signedEvent(sigsOf(2)));
            assert.strictEqual(deletes.length, 0, '2 of 4 sources is sub-quorum (600 !> 2/3 of 400*... 3*200 > 2*400 is false)');
        }
        {
            const { sync, deletes } = makeSigned({ snapRows });
            await sync._applyRetraction(signedEvent(sigsOf(3)));
            assert.strictEqual(deletes.length, 1, '3 of 4 sources meets the weighted bar');
        }
    });

    it('REFUSES when no snapshot rows exist at the claimed snapshot_block', async function () {
        const s = makeSigner();
        const { sync, deletes } = makeSigned({ snapRows: [] });
        await sync._applyRetraction(signedEvent([{ pubkey: s.pubkey, sig: s.sign(GOLDEN_CANONICAL) }]));
        assert.strictEqual(deletes.length, 0);
    });
});

describe('HubDbSync._applyRetraction signed retractions @regression @tier1', function () {
    it('REFUSES a signed set whose snapshot_block is itself below the gate era (no sub-gate minting)', async function () {
        const s = makeSigner();
        // mainnet threshold 963000: local high-water past it, but the event claims an old era
        const { sync, deletes } = makeSigned({
            snapRows: [{ signing_pubkey: s.pubkey, amount: '100', source: 'srcA' }],
            maxSnapshotBlock: 990000, network: 'mainnet'
        });
        const canonical = 'XRETRACTV1|cross_chain_calls|DOGE|42|99|7|5000';   // sb 5000 < 963000
        await sync._applyRetraction(signedEvent([{ pubkey: s.pubkey, sig: s.sign(canonical) }]));
        assert.strictEqual(deletes.length, 0);
    });

    it('legacy tier: without a wired network the fences stand alone and unsigned events apply', async function () {
        const { sync, deletes } = makeSigned({ snapRows: [], network: null });
        const evt = signedEvent(undefined);
        delete evt.retraction_signatures;
        delete evt.snapshot_block;
        await sync._applyRetraction(evt);
        assert.strictEqual(deletes.length, 1, 'no network wired -> legacy behavior (explorer vendored mirror, older wiring)');
    });

    it('legacy tier: pre-bootstrap mirror (no snapshot rows at all) applies unsigned events', async function () {
        const deletes = [];
        const doQuery = sinon.stub().callsFake(async (sql, args) => {
            if (/MAX\(snapshot_block\)/.test(sql)) return [{ sb: null }];   // empty mirror
            if (/^DELETE/.test(sql)) { deletes.push({ sql, args }); return []; }
            return [];
        });
        const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', network: 'regtest' });
        const evt = signedEvent(undefined);
        delete evt.retraction_signatures;
        delete evt.snapshot_block;
        await sync._applyRetraction(evt);
        assert.strictEqual(deletes.length, 1, 'pre-bootstrap there is no signer set to verify against');
    });

    // Twin parity: the tally marks a pubkey into the dedupe set only
    // AFTER its signature verifies, exactly as the hub producer twin
    // (RetractionConsensus.handleFinalized) and the sibling tallies in anchor.js,
    // recovery.js and StateAnchorPublisher already do. Pre-fix this consumer marked on
    // first encounter, so a garbage entry ordered ahead of the real one for the same
    // snapshot member silently under-counted the quorum and refused a hub-finalized
    // retraction (order-dependent false-reject).
    it('counts a snapshot member whose VALID signature is ordered AFTER a garbage one (verify-then-mark)', async function () {
        const s = makeSigner();
        const { sync, deletes } = makeSigned({ snapRows: [{ signing_pubkey: s.pubkey, amount: '100', source: 'srcA' }] });
        await sync._applyRetraction(signedEvent([
            { pubkey: s.pubkey, sig: 'ab'.repeat(64) },            // well-formed length, does not verify
            { pubkey: s.pubkey, sig: s.sign(GOLDEN_CANONICAL) }    // the real one, ordered second
        ]));
        assert.strictEqual(deletes.length, 1,
            'the leading garbage entry must not consume the dedupe slot for a valid signer');
    });
});

describe('HubDbSync._applyRetraction signed retractions @regression @tier1', function () {
    it('still counts a duplicated pubkey ONCE when both entries verify (dedupe intact)', async function () {
        const signers = [makeSigner(), makeSigner(), makeSigner(), makeSigner()];
        const snapRows = signers.map((s, i) => ({ signing_pubkey: s.pubkey, amount: '100', source: 'src' + i }));
        const { sync, deletes } = makeSigned({ snapRows });
        // Two real signers, one of them repeated: 2 of 4 sources is still sub-quorum.
        // Were the repeat counted twice, the weighted tally would cross the 2/3 bar.
        await sync._applyRetraction(signedEvent([
            { pubkey: signers[0].pubkey, sig: signers[0].sign(GOLDEN_CANONICAL) },
            { pubkey: signers[0].pubkey, sig: signers[0].sign(GOLDEN_CANONICAL) },
            { pubkey: signers[1].pubkey, sig: signers[1].sign(GOLDEN_CANONICAL) }
        ]));
        assert.strictEqual(deletes.length, 0, 'a repeated valid signer must not inflate the quorum tally');
    });

    it('an invalid signature alone still fails the quorum (verify gate is not weakened)', async function () {
        const s = makeSigner();
        const { sync, deletes } = makeSigned({ snapRows: [{ signing_pubkey: s.pubkey, amount: '100', source: 'srcA' }] });
        await sync._applyRetraction(signedEvent([
            { pubkey: s.pubkey, sig: 'ab'.repeat(64) },
            { pubkey: s.pubkey, sig: 'cd'.repeat(64) }
        ]));
        assert.strictEqual(deletes.length, 0, 'no verifying signature means no quorum, whatever the ordering');
    });
});

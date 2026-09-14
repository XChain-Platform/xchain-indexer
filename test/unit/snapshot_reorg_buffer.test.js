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
// the snapshot height a hub SIGNS is not the height it RESOLVED the
// validator set at. CapabilitySnapshot buries every height it is handed by
// CANONICAL_REORG_BUFFER, while the wire (checkpoint.snapshot_block, the
// mirrored capability_snapshots rows, an ATTEST request's block_index) keeps the
// RAW height, on the convention that each consumer buries exactly once. The hub
// was the only party doing so.
//
// This suite is the four-party pin the ledger's verify step asks for: a
// validator whose stake ACTIVATES or DEACTIVATES inside (N - 6, N] must be
// resolved IDENTICALLY, for the same declared snapshot_block N, by
//   1. the hub signer            (xchain-hub CapabilitySnapshot._buriedBlockIndex)
//   2. the attestation verifier  (xchain-indexer actions/attest.js)
//   3. archive recovery          (xchain-indexer recovery.js)
//   4. the SDK light client      (xchain-sdk light.js followForward)
// Parties 1 and 4 live in sibling repos; those blocks skip when the sibling is
// not checked out, matching the existing cross-repo guard convention, unless
// XCHAIN_REQUIRE_SIBLINGS=1 forces a hard failure.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const srb = require('../../src/snapshot_reorg_buffer.js');

const { siblingCheckout } = require('../helpers/sibling_checkout.js');

const HUB_DIR = path.resolve(__dirname, '../../../xchain-hub');
const SDK_DIR = path.resolve(__dirname, '../../../xchain-sdk');

// Takes one spelling per trailing argument and returns the first that exists, so
// a module the SDK layout pass moved resolves whichever side of the move the
// sibling checkout sits on. Absence still throws under XCHAIN_REQUIRE_SIBLINGS=1,
// naming every spelling tried rather than only the last.
// A spelling counts only when the shared helper will trust it, so a lane symlink into a
// live main checkout reads as unusable here too, and the refusal names the last reason.
function requireSibling(dir, ...rels){
    let verdict = null;
    for(const rel of rels){
        const p = path.join(dir, rel);
        verdict = siblingCheckout(__dirname, p);
        if(verdict.usable) return require(p);
    }
    if(process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but sibling module not found at '
            + rels.map(r => path.join(dir, r)).join(' or ') + ' (' + verdict.reason + ')');
    return null;
}

// The stake history (N, the buried height, the three keys and setAt) is shared with
// parties 2 and 3, which live beside this file under
// test/unit/snapshot_reorg_buffer.test/. Every block repeats the suite title below,
// so each full test title is unchanged.
const { N, BURIED } = require('./snapshot_reorg_buffer.test/helpers/stake_history.js');

describe('capability-snapshot reorg burial @regression @tier1', function () {

    // ── The shared constant + gate ───────────────────────────────────────────
    describe('shared snapshot_reorg_buffer module', function () {

        it('the canonical buffer is the 6-block BTC confirmation depth the hub buries by', function () {
            assert.strictEqual(srb.CANONICAL_REORG_BUFFER, 6);
        });

        it('regtest (genesis-on) buries the declared height by exactly the buffer', function () {
            assert.strictEqual(srb.buriedSnapshotBlock(N, 'regtest'), BURIED);
            assert.strictEqual(srb.buriedSnapshotBlock(6, 'regtest'), 0);
        });

        it('clamps at 0 rather than returning a negative height near genesis', function () {
            assert.strictEqual(srb.buriedSnapshotBlock(0, 'regtest'), 0);
            assert.strictEqual(srb.buriedSnapshotBlock(3, 'regtest'), 0);
        });

        it('mainnet is ARMED at genesis by the 2026-09-09 ruling, so the declared height is buried', function () {
            // Arming changes acceptance and re-reads already-anchored artifacts, so it was
            // held for an operator decision. Mainnet carries 0 validators, 0 stakes and 0
            // quorum-signed artifacts (measured 2026-09-09), so there is nothing to re-read.
            assert.strictEqual(srb.SNAPSHOT_BURIAL_ACTIVATION.mainnet, 0);
            assert.strictEqual(srb.buriedSnapshotBlock(N, 'mainnet'), BURIED);
            assert.strictEqual(srb.isSnapshotBurialActive(N, 'mainnet'), true);
            assert.strictEqual(srb.isSnapshotBurialActive(0, 'mainnet'), true);
        });

        it('testnet is ARMED at genesis, so burial applies from the first block', function () {
            // Ratified 2026-08-18 (pre-launch, every feature active on testnet). Safe because
            // testnet indexer state is rebuilt from the chain before launch and testnet holds
            // no quorum-signed artifacts to re-read: 0 validators, 0 stakes, 0 checkpoints.
            assert.strictEqual(srb.SNAPSHOT_BURIAL_ACTIVATION.testnet, 0);
            assert.strictEqual(srb.isSnapshotBurialActive(N, 'testnet'), true);
        });

        it('fails closed (no burial) on an unknown network or an unusable height', function () {
            assert.strictEqual(srb.buriedSnapshotBlock(N, 'nosuchnet'), N);
            // null/''/false must NOT be coerced to a finite 0, which would read as ACTIVE
            // on a genesis-on network and silently bury a missing height.
            for(const bad of [null, undefined, '', false, NaN, 'abc']){
                assert.strictEqual(srb.isSnapshotBurialActive(bad, 'regtest'), false,
                    String(bad) + ' must not evaluate the gate as active');
                assert.strictEqual(Object.is(srb.buriedSnapshotBlock(bad, 'regtest'), bad), true,
                    String(bad) + ' must pass through verbatim');
            }
        });
    });
});

describe('capability-snapshot reorg burial @regression @tier1', function () {

    // ── Party 1: the hub signer ──────────────────────────────────────────────
    describe('party 1: the hub signer', function () {
        let CapabilitySnapshot = null;
        before(function () {
            CapabilitySnapshot = requireSibling(HUB_DIR, 'src/validators/capability_snapshot.js');
            if(!CapabilitySnapshot) this.skip();
        });

        it('resolves at the SAME height the shared helper hands every verifier', function () {
            // The hub buries unconditionally (it always has); the shared helper is what
            // the verifiers use. A drift between the two is the whole defect, so pin them
            // across the boundary and well away from it.
            const cs = new CapabilitySnapshot({ network: 'regtest' });
            for(const h of [0, 3, 6, 7, 993, BURIED, N, N + 1, 250000]){
                assert.strictEqual(cs._buriedBlockIndex(h), srb.buriedSnapshotBlock(h, 'regtest'),
                    'hub and verifier disagree on the resolved height for declared ' + h);
            }
        });

        it('shares ONE literal buffer with the verifiers (no vendored copy to drift)', function () {
            const hubSrb = requireSibling(HUB_DIR, 'src/snapshot_reorg_buffer.js');
            assert.ok(hubSrb, 'the hub must vendor the shared module');
            assert.strictEqual(hubSrb.CANONICAL_REORG_BUFFER, srb.CANONICAL_REORG_BUFFER);
            assert.strictEqual(
                fs.readFileSync(path.join(HUB_DIR, 'src/snapshot_reorg_buffer.js'), 'utf8'),
                fs.readFileSync(path.join(__dirname, '../../src/snapshot_reorg_buffer.js'), 'utf8'),
                'the hub and indexer copies of snapshot_reorg_buffer.js have drifted');
        });
    });
});

describe('capability-snapshot reorg burial @regression @tier1', function () {

    // ── Party 4: the SDK light client ────────────────────────────────────────
    describe('party 4: the SDK light client', function () {
        let light = null;
        before(function () {
            // Post-move spelling first, then the pre-move one: the SDK moved
            // src/light.js to src/protocol/light_client.js and a sibling can sit
            // on either side of that move, so pinning one turns this party red
            // under XCHAIN_REQUIRE_SIBLINGS=1 against the other. The spellings go
            // to requireSibling together, because it THROWS on the first miss and
            // a chained fallback would never reach the second one.
            light = requireSibling(SDK_DIR, 'src/protocol/light_client.js', 'src/light.js');
            if(!light) this.skip();
        });

        it('vendors the identical shared module', function () {
            assert.strictEqual(
                fs.readFileSync(path.join(SDK_DIR, 'src/snapshot_reorg_buffer.js'), 'utf8'),
                fs.readFileSync(path.join(__dirname, '../../src/snapshot_reorg_buffer.js'), 'utf8'),
                'the sdk and indexer copies of snapshot_reorg_buffer.js have drifted');
        });

        it('followForward proves the signer set at N-6, not at the checkpoint\'s declared snapshot_block', async function () {
            // The light client trusts a checkpoint only if a quorum of the set proven at
            // its snapshot_block signed it. That set has to be the one the hub resolved,
            // or a stake change inside the buried window either rejects a valid checkpoint
            // or counts a signer the hub never had. Pin the height it ASKS for; the proof
            // body is deliberately unusable, so followForward stops right after the fetch.
            const urls = [];
            const fetchImpl = async (url) => {
                urls.push(String(url));
                return { ok: true, json: async () => (String(url).includes('/checkpoints/range')
                    ? { checkpoints: [{ block_index: 42, network: 'regtest', snapshot_block: N,
                                        state_root: '0'.repeat(64), validator_signatures: [] }] }
                    : { proof: {} }) };
            };
            const out = await light.followForward({
                explorerUrl: 'http://explorer.invalid',
                trustedCheckpoint: { block_index: 41, network: 'regtest', state_root: '0'.repeat(64) },
                toHeight: 42,
                fetchImpl,
            });
            assert.strictEqual(out.reason, 'VALIDATOR_SET_UNVERIFIED@42',
                'the stubbed proof must fail verification AFTER the set height is requested');
            const proofUrl = urls.find(u => u.includes('/proof/validator-set'));
            assert.ok(proofUrl, 'followForward must request a validator-set proof');
            assert.ok(proofUrl.includes('height=' + BURIED),
                'the light client asked for ' + proofUrl + ', not the buried height ' + BURIED);
            assert.ok(!proofUrl.includes('height=' + N),
                'the light client must not prove the set at the declared height');
        });
    });
});

describe('capability-snapshot reorg burial @regression @tier1', function () {

    // ── The comment the ledger asked to be true or gone ──────────────────────
    // The declared/resolved split moved out of actions/attest.js into the shared
    // response verifier when the chain path and the hub-mirror path were merged onto
    // one implementation. The guard follows the code:
    // it is the comment ABOVE that height that the ledger asked to be true or gone.
    it('the response verifier no longer claims it "byte-matches the hub" for the snapshot height', function () {
        const src = fs.readFileSync(path.join(__dirname, '../../src/actions/attest/attest_response_verify.js'), 'utf8');
        const declLine = src.split('\n').findIndex(l => l.includes('let declaredBlock ='));
        assert.ok(declLine > 0, 'the declared/resolved split must exist');
        // The false claim sat in the three comment lines immediately above the height.
        const preamble = src.split('\n').slice(Math.max(0, declLine - 20), declLine).join('\n');
        assert.ok(!/byte-matches the hub/.test(preamble),
            'the snapshot-height comment still asserts a byte-match the verifier does not have');
    });
});

'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// ITEM 2729: recovery.js's wrapperCanonical (the XCHECKPOINT string it builds
// for the v1 archive wrapper) had no byte-level drift coverage independent of
// its own producer. test/fixtures/anchor-archive.js hand-copies the SAME join
// to sign the wrapper, so it is a self-mirror: base-segment drift leaves the
// fixture and the producer stale together and every existing test stays green.
//
// This test derives its expectation two OTHER ways instead:
//   1. A frozen 14-segment string literal, independent of any production code.
//   2. Anchor.canonical (src/actions/anchor.js) with FORMAT=1, the rootless
//      archive form, which is the OTHER real producer of the shared first-10
//      "XCHECKPOINT" base segments (the hub / SDK / explorer all byte-match it).
//
// If wrapperCanonical's base-segment order, count, or literal ever drifts,
// both independent oracles below stop matching it while the self-mirrored
// fixture test keeps passing, closing that coverage gap.

const assert = require('assert');

const AnchorRecovery = require('../../../bin/recovery.js');
const Anchor          = require('../../../src/actions/anchor/index.js');

// snapshot_block is well below the mainnet EQUIV_HEADER_ACTIVATION threshold
// (961000), so both producers below take their pre-equivocation-header
// (raw, unwrapped) branch. That keeps this vector isolated to the 14-segment
// XCHECKPOINT join itself, which is what ITEM 2729 is about.
const v1 = {
    chain: 'DOGE',
    network: 'mainnet',
    // The checkpointed height on the SOURCE chain (here DOGE itself, since
    // the archive wrapper anchors a DOGE checkpoint), NOT block_index_doge
    // (a distinct column recorded on cross-chain match/call rows for a
    // DIFFERENT chain's block height). Mixing the two silently produces a
    // wrapper canonical that signs the wrong height.
    block_index: 4521300,
    block_hash: 'a1b2c3d4e5f6',
    ledger_hash: 'ledgerhash_abc123',
    actions_hash: 'actionshash_def456',
    contract_hash: 'contracthash_789xyz',
    checkpoint_seq: 42,
    snapshot_block: 500000,
    match_batch_seq: 7,
    match_count: 3,
    batch_crc32: 'deadbeef',
    total_chunks: 1
};

describe('recovery._wrapperCanonical: independent byte-parity (ITEM 2729)', function(){
    // Oracle 1: frozen literal, independent of any production join code.
    const EXPECTED_FROZEN =
        'XCHECKPOINT|DOGE|mainnet|4521300|a1b2c3d4e5f6|ledgerhash_abc123|actionshash_def456|' +
        'contracthash_789xyz|42|500000|7|3|deadbeef|1';

    it('matches the frozen 14-segment expectation, independent of the fixture join', function(){
        let actual = AnchorRecovery.wrapperCanonicalForTest(v1);
        assert.strictEqual(actual, EXPECTED_FROZEN);
    });

    it('embeds an upper-case batch CRC as lower-case', function(){
        let actual = AnchorRecovery.wrapperCanonicalForTest(Object.assign({}, v1, { batch_crc32: 'DEADBEEF' }));
        assert.strictEqual(actual, EXPECTED_FROZEN);
    });
});

describe('recovery._wrapperCanonical: independent byte-parity (ITEM 2729)', function(){
    // Oracle 2: the OTHER real producer of the shared 10-segment base, driven
    // independently through its own uppercase/FORMAT=1 field contract.
    function anchorBaseSegments(){
        let anchor = new Anchor({});
        let full = anchor.canonical({
            CHAIN: v1.chain,
            NETWORK: v1.network,
            BLOCK_INDEX_CHECKPOINTED: v1.block_index,
            BLOCK_HASH: v1.block_hash,
            LEDGER_HASH: v1.ledger_hash,
            ACTIONS_HASH: v1.actions_hash,
            CONTRACT_HASH: v1.contract_hash,
            CHECKPOINT_SEQ: v1.checkpoint_seq,
            SNAPSHOT_BLOCK: v1.snapshot_block,
            FORMAT: 1,
            MATCH_BATCH_SEQ: v1.match_batch_seq,
            MATCH_COUNT: v1.match_count,
            BATCH_CRC32: v1.batch_crc32,
            TOTAL_CHUNKS: v1.total_chunks
        });
        return full.split('|').slice(0, 10);
    }

    it('first 10 base segments match Anchor._canonical FORMAT=1, the other real producer', function(){
        let actual = AnchorRecovery.wrapperCanonicalForTest(v1);
        let actualBase = actual.split('|').slice(0, 10);
        assert.deepStrictEqual(actualBase, anchorBaseSegments());
    });

    it('emits exactly 14 pipe-joined segments (10 shared base + 4 archive extension)', function(){
        let actual = AnchorRecovery.wrapperCanonicalForTest(v1);
        assert.strictEqual(actual.split('|').length, 14);
    });
});

// Compare the WHOLE string, archive extension and round id included, on both sides of
// the equivocation header; the hub signer is pinned three-way in the hub's own suite.
describe('recovery wrapperCanonical vs Anchor.canonical FORMAT 1: full archive string', function(){
    const eq = require('../../../src/consensus/equivocation_header.js');
    const RAW_HEAD = 'XCHECKPOINT|DOGE|mainnet|4521300|a1b2c3d4e5f6|ledgerhash_abc123|actionshash_def456|' +
        'contracthash_789xyz|42|';

    function anchorFull(v){
        return new Anchor({}).canonical({
            CHAIN: v.chain, NETWORK: v.network, BLOCK_INDEX_CHECKPOINTED: v.block_index,
            BLOCK_HASH: v.block_hash, LEDGER_HASH: v.ledger_hash, ACTIONS_HASH: v.actions_hash,
            CONTRACT_HASH: v.contract_hash, CHECKPOINT_SEQ: v.checkpoint_seq,
            SNAPSHOT_BLOCK: v.snapshot_block, FORMAT: 1,
            MATCH_BATCH_SEQ: v.match_batch_seq, MATCH_COUNT: v.match_count,
            BATCH_CRC32: v.batch_crc32, TOTAL_CHUNKS: v.total_chunks
        });
    }
    function atEquiv(overrides){
        return Object.assign({}, v1, { snapshot_block: eq.EQUIV_HEADER_ACTIVATION.mainnet }, overrides);
    }
    // Read the round id: the text between the leading 'EQUIV|' and the first '||'.
    function roundIdOf(s){
        return s.slice('EQUIV|'.length, s.indexOf('||'));
    }

    it('below the equivocation header both builders emit the same bare archive string', function(){
        assert.strictEqual(eq.isEquivHeaderActive(v1.snapshot_block, v1.network), false);
        assert.strictEqual(anchorFull(v1), RAW_HEAD + '500000|7|3|deadbeef|1');
        assert.strictEqual(AnchorRecovery.wrapperCanonicalForTest(v1), anchorFull(v1));
    });

    it('once the equivocation header is active both builders emit the same wrapped archive string', function(){
        const at = atEquiv({});
        const h = eq.EQUIV_HEADER_ACTIVATION.mainnet;
        assert.strictEqual(eq.isEquivHeaderActive(at.snapshot_block, at.network), true);
        assert.strictEqual(anchorFull(at),
            'EQUIV|XCHECKPOINT|DOGE|mainnet|4521300|42|7|0||' + RAW_HEAD + h + '|7|3|deadbeef|1');
        assert.strictEqual(AnchorRecovery.wrapperCanonicalForTest(at), anchorFull(at));
    });

    it('both builders carry the batch seq in the archive round id', function(){
        assert.strictEqual(roundIdOf(anchorFull(atEquiv({}))), 'XCHECKPOINT|DOGE|mainnet|4521300|42|7|0');
        const next = atEquiv({ match_batch_seq: 8 });
        assert.strictEqual(roundIdOf(anchorFull(next)), 'XCHECKPOINT|DOGE|mainnet|4521300|42|8|0');
        assert.strictEqual(roundIdOf(AnchorRecovery.wrapperCanonicalForTest(next)), roundIdOf(anchorFull(next)));
    });

    it('both builders embed an upper-case batch CRC as lower-case on both sides of the header', function(){
        for(const v of [v1, atEquiv({})]){
            const upper = Object.assign({}, v, { batch_crc32: 'DEADBEEF' });
            assert.strictEqual(anchorFull(upper), anchorFull(v));
            assert.strictEqual(AnchorRecovery.wrapperCanonicalForTest(upper), anchorFull(v));
        }
    });
});

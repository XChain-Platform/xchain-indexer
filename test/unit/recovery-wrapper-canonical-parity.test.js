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

// ITEM 2729: recovery.js's _wrapperCanonical (the XCHECKPOINT string it builds
// for the v1 archive wrapper) had no byte-level drift coverage independent of
// its own producer. test/fixtures/anchor-archive.js hand-copies the SAME join
// to sign the wrapper, so it is a self-mirror: base-segment drift leaves the
// fixture and the producer stale together and every existing test stays green.
//
// This test derives its expectation two OTHER ways instead:
//   1. A frozen 14-segment string literal, independent of any production code.
//   2. Anchor._canonical (src/actions/anchor.js) with FORMAT=1, the rootless
//      archive form, which is the OTHER real producer of the shared first-10
//      "XCHECKPOINT" base segments (the hub / SDK / explorer all byte-match it).
//
// If _wrapperCanonical's base-segment order, count, or literal ever drifts,
// both independent oracles below stop matching it while the self-mirrored
// fixture test keeps passing, closing that coverage gap.

const assert = require('assert');

const AnchorRecovery = require('../../src/recovery.js');
const Anchor          = require('../../src/actions/anchor.js');

describe('recovery._wrapperCanonical: independent byte-parity (ITEM 2729)', function(){

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

    // Oracle 1: frozen literal, independent of any production join code.
    const EXPECTED_FROZEN =
        'XCHECKPOINT|DOGE|mainnet|4521300|a1b2c3d4e5f6|ledgerhash_abc123|actionshash_def456|' +
        'contracthash_789xyz|42|500000|7|3|deadbeef|1';

    // Oracle 2: the OTHER real producer of the shared 10-segment base, driven
    // independently through its own uppercase/FORMAT=1 field contract.
    function anchorBaseSegments(){
        let anchor = new Anchor({});
        let full = anchor._canonical({
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

    it('matches the frozen 14-segment expectation, independent of the fixture join', function(){
        let actual = AnchorRecovery.wrapperCanonicalForTest(v1);
        assert.strictEqual(actual, EXPECTED_FROZEN);
    });

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

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 *
 * The v0.28.0 TBTC rebuild stall at block 157234, reproduced at the checkpoint pick.
 *
 * Transfer 4d6b21ba (100 papeto, DOGE to BTC, snapshot_block 155055) settles at BTC block
 * 157235, the BRIDGE_ESCROW_ANCHOR_MATCH_ACTIVATION height, so its DOGE checkpoint is picked on
 * the anchor axis: the first mirrored row with snapshot_block above 155055, re-verified against
 * the oracle_publish stake at the row's own snapshot_block. Every DOGE checkpoint the hub
 * mirrored in that range carries the same four signatures, four sources of 50000 each.
 *
 * The original network had evicted sources 16 and 17 at 152388 and source 41 at 153396 by
 * ROLLCALL liveness eviction, so the roster at 155056 was five sources of 50000 and one of
 * 25000: 200000 of 275000 signed, above two thirds, and the first row was picked. The v0.28.0
 * replay forked its ledger hash at 150698 (see test/unit/actions/execute/vm_token_info_bridged.test.js),
 * every ROLLCALL signature failed against it, nobody was evicted, and the roster kept four
 * 25000 sources: 200000 of 350000, so all eight candidates the bounded read returns fail and
 * the block stalls. With only the 152388 evictions the roster is 300000 and 200000 is exactly
 * two thirds, which the strict threshold also refuses, so both evictions are needed.
 *
 * These cases document the chain at the pick. The fix is in the VM token info, not here: the
 * pick, its bound and the quorum rule are unchanged.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const PC     = require('../../../../src/consensus/bridge_proof_client.js');
const SRC    = require('../../../../src/consensus/bridge_proof_client/checkpoint_source.js');
const swq    = require('../../../../src/consensus/stake_weighted_quorum.js');
const anchorsMixin = require('../../../../src/db/anchors');
const { makeKey, sign } = require('../bridge_settle.test/helpers/settle_fixtures.js');

const NET = 'testnet';
const SNAP = 155055;
const SETTLE_BLOCK = 157235;

// The DOGE checkpoints the hub mirrored above the stamp, lowest first (block_index, snapshot_block).
const DOGE_ROWS = [[67964142, 155056], [67964311, 155063], [67964439, 155069], [67964478, 155075],
                   [67964640, 155081], [67964825, 155087], [67965114, 155093], [67965420, 155099],
                   [67965708, 155105]];

function hex(c){ return c.repeat(64); }

// Five verifier sources of 50000 (the first four sign every row) and the four 25000 sources
// that never sign: 16, 17, 41 and 42 in the original's numbering.
const VERIFIERS = Array.from({ length: 5 }, (_, i) => ({ key: makeKey(), source: 'mverify' + (i + 1), weight: '50000.00000000' }));
const SILENT = ['src16', 'src17', 'src41', 'src42'].map((source) => ({ key: makeKey(), source, weight: '25000.00000000' }));
const SIGNERS = VERIFIERS.slice(0, 4);

function roster(members){
    return members.map((m) => ({ pubkey: m.key.pubkey, source: m.source, weight: m.weight }));
}
const REBUILD_ROSTER = roster(VERIFIERS.concat(SILENT));
const ORIGINAL_ROSTER = roster(VERIFIERS.concat(SILENT.filter((m) => m.source === 'src42')));
const ONE_EPOCH_ROSTER = roster(VERIFIERS.concat(SILENT.filter((m) => m.source === 'src41' || m.source === 'src42')));

// One mirrored state_checkpoints row, signed by SIGNERS over the canonical the pick rebuilds.
function mirroredRow([blockIndex, snapshotBlock], id){
    const row = { id, chain: 'DOGE', network: NET, block_index: blockIndex, block_hash: hex('b'),
                  ledger_hash: hex('1'), actions_hash: hex('2'), contract_hash: hex('3'),
                  checkpoint_seq: snapshotBlock, snapshot_block: snapshotBlock, supersedes_from: null,
                  rules_digest: null, state_root: hex('a'), state_root_version: 2,
                  block_merkle_root: hex('c'), block_merkle_version: 1 };
    const canonical = SRC.checkpointCanonical(row);
    row.validator_signatures = JSON.stringify(SIGNERS.map((m) => ({ pubkey: m.key.pubkey, sig: sign(m.key.privateKey, canonical) })));
    return row;
}
const MIRROR = DOGE_ROWS.map((r, i) => mirroredRow(r, 2133 + i));

// The TBTC indexer holds no anchor_actions (anchors live on DOGE), so Source 1 is empty and the
// mirror is the only source. The mirror double applies the shipped query's range, order and limit.
function pickCtx(rosterAtSnapshot){
    const reads = { candidates: 0, rosterReads: [] };
    const mirror = {
        doQueryStrict: async (sql, args) => {
            if(/supersedes_from IS NOT NULL/.test(sql)) return [];
            const [chain, network, after] = args;
            const limit = Number(/LIMIT\s+(\d+)/i.exec(sql)[1]);
            assert.ok(/snapshot_block\s*>\s*\?/.test(sql) && /ORDER BY snapshot_block ASC/.test(sql));
            const rows = MIRROR.filter((r) => r.chain === chain && r.network === network && r.snapshot_block > Number(after))
                .sort((a, b) => a.snapshot_block - b.snapshot_block).slice(0, limit);
            reads.candidates = rows.length;
            return rows;
        },
    };
    const db = {
        doQueryStrict: async () => [],
        mirrorDb: () => mirror,
        getStakeWeightsByCapability: async (capability, height) => {
            reads.rosterReads.push([capability, height]);
            return rosterAtSnapshot.slice();
        },
        getValidatorsByCapability: async () => { throw new Error('the count rule is not in force at 155056'); },
    };
    for(const m of ['getEarliestValidAnchorCheckpointAfterAnchor', 'getMirroredStateCheckpointCandidatesAfterAnchor',
                    'getMirroredCheckpointSuperseders'])
        db[m] = anchorsMixin[m].bind(db);
    return { ctx: { indexerDb: db, coin: 'BTC', network: NET, blockIndex: SETTLE_BLOCK }, reads };
}

function transferRow(){
    return { transfer_id: '4d6b21baa37a4da90c7b96b4899a3d9cc55c1a46bb7e339f3b08822e8cbb8a9b', snapshot_block: SNAP,
             network: NET, src_chain: 'DOGE', src_action_index: 4369, dest_chain: 'BTC', tick: 'papeto',
             decimals: 0, amount: '100' };
}

describe('bridge escrow checkpoint pick against the ROLLCALL-evicted roster (TBTC 157235) @regression @tier1', function(){

    it('stake weighting is the rule at the rows\' own snapshot_block', function(){
        assert.strictEqual(swq.isStakeWeightedQuorumActive(155056, NET), true);
    });

    it('the rebuild\'s 9-source roster verifies none of the eight candidates, so the block stalls', async function(){
        const { ctx, reads } = pickCtx(REBUILD_ROSTER);
        const pick = await PC.selectCheckpoint(transferRow(), ctx);
        assert.strictEqual(pick, null);
        assert.strictEqual(reads.candidates, 8, 'the bounded read returns eight rows');
        assert.deepStrictEqual(reads.rosterReads.map((r) => r[1]), MIRROR.slice(0, 8).map((r) => r.snapshot_block));
        assert.ok(reads.rosterReads.every((r) => r[0] === 'oracle_publish'));
    });

    it('the original\'s roster after the 152388 and 153396 evictions picks the first row above the stamp', async function(){
        const { ctx } = pickCtx(ORIGINAL_ROSTER);
        const pick = await PC.selectCheckpoint(transferRow(), ctx);
        assert.ok(pick, 'a checkpoint is picked');
        assert.strictEqual(pick.snapshot_block, 155056);
        assert.strictEqual(pick.block_index, 67964142);
        assert.strictEqual(pick.source, 'state_checkpoints');
    });

    it('with only the 152388 evictions 200000 of 300000 is exactly two thirds and still stalls', async function(){
        const { ctx } = pickCtx(ONE_EPOCH_ROSTER);
        assert.strictEqual(await PC.selectCheckpoint(transferRow(), ctx), null);
    });
});

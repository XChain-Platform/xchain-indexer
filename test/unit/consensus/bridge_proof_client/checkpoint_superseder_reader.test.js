/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 * Unit: mirrored checkpoint superseder scope
 */

'use strict';

const assert = require('assert');

const anchors = require('../../../../src/db/anchors/index.js');
const { selectCheckpoint } = require(
    '../../../../src/consensus/bridge_proof_client/checkpoint_source.js');

const CHECKPOINT = {
    chain: 'BTC', network: 'regtest', block_index: 100, checkpoint_seq: 10,
    snapshot_block: 100, state_root: 'a'.repeat(64), state_root_version: 2
};

function transfer(){
    return { src_chain: 'BTC', network: 'regtest', snapshot_block: 100 };
}

function context(db){
    return { indexerDb: db, coin: 'BTC', network: 'regtest', blockIndex: 200 };
}

describe('mirrored checkpoint superseder reader @regression @tier1', function(){
    it('queries every later superseding marker without candidate-page filters', async function(){
        const calls = [];
        const self = { mirrorDb: () => ({
            doQueryStrict: async (sql, params) => { calls.push({ sql, params }); return []; }
        }) };
        await anchors.getMirroredCheckpointSuperseders.call(self, 'BTC', 'regtest', 10, 100);
        assert.strictEqual(calls.length, 1);
        assert.match(calls[0].sql, /checkpoint_seq\s*>\s*\?/);
        assert.match(calls[0].sql, /supersedes_from\s*<=\s*\?/);
        assert.doesNotMatch(calls[0].sql, /\bLIMIT\b|state_root/i);
        assert.deepStrictEqual(calls[0].params, ['BTC', 'regtest', 10, 100]);
    });

    it('rejects a marker outside the eight-row candidate page', async function(){
        const db = {
            getEarliestValidAnchorCheckpoint: async () => [],
            getMirroredStateCheckpointCandidates: async () => [CHECKPOINT],
            getMirroredCheckpointSuperseders: async () => [{
                chain: 'BTC', network: 'regtest', checkpoint_seq: 40, supersedes_from: 90
            }]
        };
        await assert.rejects(() => selectCheckpoint(transfer(), context(db)), err => {
            assert.strictEqual(err.code, 'CHECKPOINT_SUPERSEDED');
            assert.strictEqual(err.superseded_by_seq, 40);
            return true;
        });
    });

    it('fails closed when the consensus reader is absent', async function(){
        const db = {
            getEarliestValidAnchorCheckpoint: async () => [],
            getMirroredStateCheckpointCandidates: async () => [CHECKPOINT]
        };
        await assert.rejects(() => selectCheckpoint(transfer(), context(db)), err => {
            assert.ok(err instanceof TypeError);
            assert.match(err.message, /getMirroredCheckpointSuperseders/);
            return true;
        });
    });
});

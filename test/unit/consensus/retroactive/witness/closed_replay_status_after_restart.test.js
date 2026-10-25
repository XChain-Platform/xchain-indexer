/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Restart status for a completed retroactive replay witness.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');

const { rulesStatus } = require('../../../../../src/api/health.js');
const { gateMapDigest } = require('../../../../../src/consensus/retroactive/boot_replay.js');
const {
    buildReplayMarker,
    advanceReplayMarker,
} = require('../../../../../src/consensus/retroactive/replay_marker.js');
const {
    buildReplayWitness,
    nextWitnessPhase,
} = require('../../../../../src/consensus/retroactive/replay_witness.js');
const {
    REPLAY_WITNESS_PHASE_CODE,
    encodedRows,
} = require('../../../../../src/db/events/retroactive_replay_witness.js');
const changes = require('../../../../../src/protocol_changes.js');
const startup = require('../../../../../src/XChainIndexer/startup.js');

const TARGET = 40;
const REPLAY_TO = 44;
const MAP = { 'example.ACTIVATION': 200 };
const RULES_FROM = gateMapDigest(MAP);
const RULES_TO = 'b'.repeat(64);

function replayMarker(state, values = {}){
    let marker = buildReplayMarker({
        target: TARGET,
        replayTo: REPLAY_TO,
        rulesFrom: RULES_FROM,
        rulesTo: RULES_TO,
        ...values,
    });
    if(state !== 'pending') marker = advanceReplayMarker(marker, 'replaying');
    return state === 'replayed' ? advanceReplayMarker(marker, 'replayed') : marker;
}

function replayWitness(phase){
    const witness = buildReplayWitness({
        target: TARGET,
        replayTo: REPLAY_TO,
        rulesFrom: RULES_FROM,
        gateHeights: MAP,
        blocks: Array.from({ length: REPLAY_TO - TARGET + 1 }, (_, offset) => ({
            block_index: TARGET + offset,
            block_hash: String(TARGET + offset).padStart(64, '0'),
        })),
    });
    if(phase === 'witness') return witness;
    return Object.assign({}, witness, {
        phase: nextWitnessPhase(witness.phase, phase, phase === 'final' ? false : undefined),
    });
}

function eventRows(witness){
    const basePhase = Object.assign({}, witness.phase, { phase: 'witness' });
    delete basePhase.changed;
    const rows = encodedRows(Object.assign({}, witness, {
        phase: basePhase,
    })).map((row, offset) => ({
        id: offset + 1,
        code: row.code,
        data: row.data,
        witness_hash: witness.batch,
    }));
    if(witness.phase.phase !== 'witness'){
        rows.push({
            id: rows.length + 1,
            code: REPLAY_WITNESS_PHASE_CODE,
            data: JSON.stringify(witness.phase),
            witness_hash: witness.batch,
        });
    }
    return rows;
}

function bootIndexer(marker, witness, tip = REPLAY_TO){
    const events = eventRows(witness);
    const db = {
        async doQueryStrict(sql, params){
            if(/ORDER BY id DESC LIMIT 1$/.test(sql)){
                const rows = events.filter(row => row.code === params[0]);
                return rows.length === 0 ? [] : [rows[rows.length - 1]];
            }
            if(/witness_hash = \? AND id < \?/.test(sql)){
                return events.filter(row => row.code === params[0] &&
                    row.witness_hash === params[1] && row.id < params[2])
                    .reverse().slice(0, params[3]).map(row => ({ data: row.data }));
            }
            throw new Error('unexpected query: ' + sql);
        },
        getBlockIndex: async () => tip,
        consensusHeightGateMap: () => MAP,
        readConsensusGateBoot: async () => ({
            recorded: { gateHeights: MAP, appliedTip: tip, scope: 'registry' },
            replayMarker: marker,
        }),
        recordConsensusGateBoot: async () => {},
    };
    const indexer = {
        config: { NETWORK: 'regtest', COIN: 'BTC', RETROACTIVE_REPLAY_CAP_BLOCKS: 1728 },
        indexerDb: db,
        rollback: { rollback: async () => {} },
        util: { throwError(message){ throw new Error(message); } },
        holdRetroactiveReplay: startup.holdRetroactiveReplay,
        holdRetroactiveReplayNeedsGo: startup.holdRetroactiveReplayNeedsGo,
        holdRetroactiveReplayDiverged: startup.holdRetroactiveReplayDiverged,
        recordConsensusGateBoot: startup.recordConsensusGateBoot,
    };
    return indexer.recordConsensusGateBoot().then(() => indexer);
}

describe('closed replay status after restart @regression @tier1', function(){
    let baseOverlay;

    beforeEach(function(){
        baseOverlay = changes.registry.getReadOverlay();
    });

    afterEach(function(){
        changes.registry.setReadOverlay(baseOverlay);
    });

    it('reports a matching final witness result for a closed marker', async function(){
        const indexer = await bootIndexer(replayMarker('replayed'), replayWitness('final'));
        const status = rulesStatus(indexer);

        assert.strictEqual(indexer.replayWitnessPhase, null);
        assert.strictEqual(status.replay.witness, 'passed');
        assert.strictEqual(status.replay.changed, false);
    });

    it('ignores a final witness that does not identify the closed marker', async function(){
        for(const marker of [
            replayMarker('replayed', { target: TARGET - 1 }),
            replayMarker('replayed', { replayTo: REPLAY_TO + 1 }),
            replayMarker('replayed', { rulesFrom: 'c'.repeat(64) }),
        ]){
            const status = rulesStatus(await bootIndexer(marker, replayWitness('final')));
            assert.strictEqual(status.replay.witness, null);
            assert.strictEqual(status.replay.changed, null);
        }
    });

    it('keeps an open marker on the active phased path', async function(){
        const indexer = await bootIndexer(
            replayMarker('replaying'), replayWitness('witness'), TARGET - 1);
        const status = rulesStatus(indexer);

        assert.strictEqual(indexer.replayWitnessPhase, 'witness');
        assert.strictEqual(indexer.replayWitness.phase.phase, 'witness');
        assert.strictEqual(status.replay.witness, 'running');
        assert.strictEqual(status.replay.changed, null);
    });
});

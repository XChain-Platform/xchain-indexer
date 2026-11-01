/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 *
 * Public replay witness status and the operator rewitness command.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');

const { canonical } = require('../../../../src/consensus_rules_digest.js');
const { rulesStatus } = require('../../../../src/api/health.js');
const { rulesStatusBody } = require('../../../../src/consensus/retroactive/replay_status.js');
const { buildReplayWitness } = require('../../../../src/consensus/retroactive/replay_witness.js');
const {
    REPLAY_WITNESS_PHASE_CODE,
    encodedRows,
} = require('../../../../src/db/events/retroactive_replay_witness.js');
const { main } = require('../../../../bin/retroactive-go.js');

const RECORDED = { 'example.ACTIVATION': 200 };
const RULES_FROM = crypto.createHash('sha256').update(canonical(RECORDED)).digest('hex');
const RULES_TO = 'b'.repeat(64);
const marker = {
    state: 'replaying',
    target: 40,
    replay_to: 44,
    rules_from: RULES_FROM,
    rules_to: RULES_TO,
};

function phase(name, changed){
    return {
        phase: name,
        target: marker.target,
        replay_to: marker.replay_to,
        rules_from: RULES_FROM,
        window_count: 1,
        map_count: 1,
        ...(changed === undefined ? {} : { changed }),
    };
}

describe('retroactive replay witness status @regression @tier1', function(){
    it('reports running, passed, diverged, and null for a pre-feature marker', function(){
        const cases = [
            [phase('witness'), 'running', null],
            [phase('witnessed', false), 'passed', false],
            [phase('final', true), 'passed', true],
            [phase('diverged', true), 'diverged', true],
            [null, null, null],
        ];

        for(const [witnessPhase, status, changed] of cases){
            const body = rulesStatusBody(RULES_TO, marker, witnessPhase);
            assert.strictEqual(body.replay.witness, status);
            assert.strictEqual(body.replay.changed, changed);
        }
    });

    it('pins rules.digest to rules_to only while the witness overlay is active', function(){
        const current = { 'example.ACTIVATION': 100 };
        const currentDigest = crypto.createHash('sha256')
            .update(canonical(current)).digest('hex');
        const indexer = {
            config: { NETWORK: 'regtest', COIN: 'BTC' },
            indexerDb: { consensusHeightGateMap: () => current },
            replayMarker: marker,
            replayWitness: { phase: phase('witness') },
        };

        assert.strictEqual(rulesStatus(indexer).digest, RULES_TO);
        indexer.replayWitness.phase = phase('witnessed', false);
        assert.strictEqual(rulesStatus(indexer).digest, currentDigest);
        indexer.replayWitness = null;
        assert.strictEqual(rulesStatus(indexer).digest, currentDigest);
    });

    it('--rewitness appends a fresh witness phase for the latest recorded batch', async function(){
        const witness = buildReplayWitness({
            target: marker.target,
            replayTo: marker.replay_to,
            rulesFrom: RULES_FROM,
            gateHeights: RECORDED,
            blocks: Array.from({ length: 5 }, (_, offset) => ({
                block_index: marker.target + offset,
                block_hash: String(marker.target + offset).padStart(64, '0'),
            })),
        });
        const rows = encodedRows(witness);
        const phaseRow = rows[rows.length - 1];
        const inserts = [];
        const db = {
            async doQueryStrict(sql, params){
                if(/^INSERT INTO events/.test(sql)){
                    inserts.push(params);
                    return [];
                }
                if(/ORDER BY id DESC LIMIT 1/.test(sql))
                    return [{ id: 50, data: phaseRow.data, witness_hash: witness.batch }];
                return rows.filter(row => row.code === params[0]).slice().reverse()
                    .map(row => ({ data: row.data }));
            },
        };
        let output = '';

        const written = await main(['--rewitness'], { db, write: text => { output += text; } });

        assert.strictEqual(inserts.length, 1);
        assert.strictEqual(inserts[0][0], REPLAY_WITNESS_PHASE_CODE);
        assert.strictEqual(inserts[0][2], witness.batch);
        assert.deepStrictEqual(JSON.parse(inserts[0][1]), phase('witness'));
        assert.deepStrictEqual(written, phase('witness'));
        assert.match(output, /recorded rewitness for target 40/);
    });
});

/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * A boot rollback first records compact evidence for its old-chain window.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const {
    gateMapDigest,
    runBootReplay,
} = require('../../../../src/consensus/retroactive/boot_replay.js');
const {
    REPLAY_WITNESS_WINDOW_SIZE,
    buildReplayWitness,
    rebuildWitnessMap,
} = require('../../../../src/consensus/retroactive/replay_witness.js');
const {
    REPLAY_WITNESS_WINDOW_CODE,
    REPLAY_WITNESS_MAP_CODE,
    REPLAY_WITNESS_PHASE_CODE,
    REPLAY_WITNESS_DATA_MAX,
    encodedRows,
    recordReplayWitness,
    readLatestReplayWitness,
    readReplayWitnessBlocks,
    readReplayWitnessMap,
} = require('../../../../src/db/events/retroactive_replay_witness.js');

const MOVABLE = 'movable_activation.MOVABLE_ACTIVATION';
const FIXED = 'fixed_activation.FIXED_ACTIVATION';
const RECORDED = { [FIXED]: 5, [MOVABLE]: 200 };
const CURRENT = { [FIXED]: 5, [MOVABLE]: 95 };

function block(height){
    return { block_index: height, block_hash: height.toString(16).padStart(64, '0') };
}

function blocks(from, to){
    return Array.from({ length: to - from + 1 }, (_, offset) => block(from + offset));
}

function dbHarness(timeline = []){
    const calls = [];
    return {
        calls,
        async doQueryStrict(sql, params){
            calls.push({ sql: String(sql), params });
            timeline.push(params && params[0] ? params[0] : 'read');
            return [];
        },
    };
}

describe('retroactive replay witness record @regression @tier1', function(){
    it('chunks target through replay_to into deterministic 64-block windows', function(){
        const witness = buildReplayWitness({
            target: 100,
            replayTo: 229,
            rulesFrom: gateMapDigest(RECORDED),
            gateHeights: RECORDED,
            blocks: blocks(100, 229),
        });

        assert.strictEqual(REPLAY_WITNESS_WINDOW_SIZE, 64);
        assert.deepStrictEqual(witness.windows.map(row => row.slice(0, 2)), [
            [100, 163], [164, 227], [228, 229],
        ]);
        assert.ok(witness.windows.every(row => /^[0-9a-f]{64}$/.test(row[2])));
        assert.notStrictEqual(witness.windows[0][2], witness.windows[1][2]);
    });

    it('writes every window, map, and phase row before the boot rollback', async function(){
        const timeline = [];
        const db = dbHarness(timeline);
        const witnessBlocks = blocks(95, 100);
        const deps = {
            readBoot: async () => ({
                recorded: { gateHeights: RECORDED, appliedTip: 100, scope: 'registry' },
                replayMarker: null,
            }),
            readMirrorGap: async () => null,
            goMatches: async () => false,
            readWitnessBlocks: async (target, tip) => {
                assert.deepStrictEqual([target, tip], [95, 100]);
                return witnessBlocks;
            },
            recordWitness: witness => recordReplayWitness(db, witness),
            recordMarker: async () => timeline.push('marker'),
            recordBoot: async () => timeline.push('boot'),
            rollback: async () => timeline.push('rollback'),
            holdReplay: () => timeline.push('hold'),
            holdNeedsGo: () => {},
            refuse: message => { throw new Error(message); },
        };

        await runBootReplay({
            tip: 100,
            current: CURRENT,
            capBlocks: 10,
            movableGates: [MOVABLE],
        }, deps);

        const eventCodes = timeline.filter(item => item.startsWith('CONSENSUS_RETRO_WITNESS'));
        assert.deepStrictEqual(eventCodes, [
            REPLAY_WITNESS_WINDOW_CODE,
            REPLAY_WITNESS_MAP_CODE,
            REPLAY_WITNESS_MAP_CODE,
            REPLAY_WITNESS_PHASE_CODE,
        ]);
        assert.ok(eventCodes.every(code => timeline.indexOf(code) < timeline.indexOf('rollback')));
        assert.ok(timeline.indexOf(REPLAY_WITNESS_PHASE_CODE) < timeline.indexOf('marker'));
    });

    it('keeps every persisted row within events.data and writes the phase fence last', function(){
        const longKeyMap = { ['z'.repeat(160)]: 9999999999, [MOVABLE]: 95 };
        const witness = buildReplayWitness({
            target: 95,
            replayTo: 100,
            rulesFrom: gateMapDigest(longKeyMap),
            gateHeights: longKeyMap,
            blocks: blocks(95, 100),
        });
        const rows = encodedRows(witness);

        assert.ok(rows.every(row => Buffer.byteLength(row.data, 'utf8') < REPLAY_WITNESS_DATA_MAX));
        assert.strictEqual(rows[rows.length - 1].code, REPLAY_WITNESS_PHASE_CODE);
        assert.deepStrictEqual(JSON.parse(rows[rows.length - 1].data), {
            phase: 'witness',
            target: 95,
            replay_to: 100,
            rules_from: gateMapDigest(longKeyMap),
            window_count: 1,
            map_count: 2,
        });
    });

    it('rebuilds the recorded map to rules_from and refuses a changed map', async function(){
        const rulesFrom = gateMapDigest(RECORDED);
        const witness = buildReplayWitness({
            target: 95,
            replayTo: 100,
            rulesFrom,
            gateHeights: RECORDED,
            blocks: blocks(95, 100),
        });

        const rebuilt = rebuildWitnessMap(witness.map, rulesFrom);
        assert.deepStrictEqual(rebuilt, RECORDED);
        assert.strictEqual(gateMapDigest(rebuilt), rulesFrom);
        assert.throws(
            () => rebuildWitnessMap(witness.map.concat([['injected.ACTIVATION', 4]]), rulesFrom),
            /witness_map_mismatch/
        );

        const rows = witness.map.map(data => ({ data: JSON.stringify(data) }));
        const db = { doQueryStrict: async () => rows };
        assert.deepStrictEqual(await readReplayWitnessMap(
            db, witness.batch, rulesFrom, witness.map.length, 10), RECORDED);
        rows[0] = { data: JSON.stringify([FIXED, 6]) };
        await assert.rejects(readReplayWitnessMap(
            db, witness.batch, rulesFrom, witness.map.length, 10), /witness_map_mismatch/);
    });

    it('reads the latest complete batch and verifies its rebuilt map', async function(){
        const rulesFrom = gateMapDigest(RECORDED);
        const witness = buildReplayWitness({
            target: 95,
            replayTo: 100,
            rulesFrom,
            gateHeights: RECORDED,
            blocks: blocks(95, 100),
        });
        const rows = encodedRows(witness);
        const phase = rows[rows.length - 1];
        const db = {
            async doQueryStrict(sql, params){
                if(/ORDER BY id DESC LIMIT 1/.test(sql))
                    return [{ id: 50, data: phase.data, witness_hash: witness.batch }];
                const code = params[0];
                return rows.filter(row => row.code === code).slice().reverse()
                    .map(row => ({ data: row.data }));
            },
        };

        const rebuilt = await readLatestReplayWitness(db);
        assert.strictEqual(rebuilt.batch, witness.batch);
        assert.deepStrictEqual(rebuilt.windows, witness.windows);
        assert.deepStrictEqual(rebuilt.gateHeights, RECORDED);
        assert.strictEqual(gateMapDigest(rebuilt.gateHeights), rebuilt.phase.rules_from);
    });

    it('reads old-chain blocks in deterministic height and row order', async function(){
        let query;
        let params;
        const db = {
            async doQueryStrict(sql, values){
                query = sql;
                params = values;
                return blocks(95, 100).map(row => ({ block_index: row.block_index }));
            },
        };
        const decoderDb = {
            getDecoderBlockHashRow: async height => [{ block_hash: block(height).block_hash }],
        };

        assert.deepStrictEqual(await readReplayWitnessBlocks(db, decoderDb, 95, 100), blocks(95, 100));
        assert.match(query, /ORDER BY b\.block_index ASC, b\.id ASC/);
        assert.deepStrictEqual(params, [95, 100]);
    });

    it('refuses missing or non-contiguous block evidence', function(){
        const input = {
            target: 95,
            replayTo: 100,
            rulesFrom: gateMapDigest(RECORDED),
            gateHeights: RECORDED,
            blocks: blocks(95, 100),
        };
        assert.throws(() => buildReplayWitness({ ...input, blocks: input.blocks.slice(1) }),
            /must cover target through replayTo/);
        const gapped = input.blocks.slice();
        gapped[2] = block(99);
        assert.throws(() => buildReplayWitness({ ...input, blocks: gapped }), /must be contiguous/);
    });
});

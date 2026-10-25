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
 * Replay witness digests cover every stored commitment for each block.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const {
    REPLAY_WITNESS_PHASES,
    buildReplayWitness,
    decodeReplayWitnessPhase,
    observedWindowDigest,
} = require('../../../../../src/consensus/retroactive/replay_witness.js');
const {
    readReplayWitnessBlocks,
} = require('../../../../../src/db/events/retroactive_replay_witness.js');

const hash = character => character.repeat(64);

function row(height, values = {}){
    return {
        block_index: height,
        block_hash: height.toString(16).padStart(64, '0'),
        ledger_hash: hash('a'),
        actions_hash: hash('b'),
        contract_hash: hash('c'),
        state_root: hash('d'),
        ...values,
    };
}

describe('retroactive replay witness digest fields @regression @tier1', function(){
    it('binds every stored commitment into the observed digest', function(){
        const original = [row(5)];
        const baseline = observedWindowDigest(original, 5, 5);

        for(const [field, value] of [
            ['block_hash', hash('e')],
            ['ledger_hash', hash('e')],
            ['actions_hash', hash('e')],
            ['contract_hash', hash('e')],
            ['state_root', hash('e')],
        ])
            assert.notStrictEqual(
                observedWindowDigest([{ ...original[0], [field]: value }], 5, 5),
                baseline,
                field
            );
    });

    it('normalizes hash case and treats absent optional commitments as null', function(){
        const uppercase = [row(5, {
            block_hash: hash('A'),
            ledger_hash: hash('B'),
            actions_hash: hash('C'),
            contract_hash: hash('D'),
            state_root: hash('E'),
        })];
        const lowercase = [Object.fromEntries(
            Object.entries(uppercase[0]).map(([key, value]) => [
                key, typeof value === 'string' ? value.toLowerCase() : value,
            ])
        )];
        assert.strictEqual(
            observedWindowDigest(uppercase, 5, 5),
            observedWindowDigest(lowercase, 5, 5)
        );

        const absent = [{ block_index: 5, block_hash: hash('f') }];
        const nullable = [{
            ...absent[0],
            ledger_hash: null,
            actions_hash: null,
            contract_hash: null,
            state_root: null,
        }];
        assert.strictEqual(
            observedWindowDigest(absent, 5, 5),
            observedWindowDigest(nullable, 5, 5)
        );
    });

    it('uses the observed digest when recording witness windows', function(){
        const blocks = [row(5), row(6)];
        const witness = buildReplayWitness({
            target: 5,
            replayTo: 6,
            rulesFrom: hash('f'),
            gateHeights: {},
            blocks,
        });

        assert.strictEqual(witness.windows[0][2], observedWindowDigest(blocks, 5, 6));
    });

    it('refuses malformed optional commitments and non-contiguous ranges', function(){
        for(const value of ['', 'a'.repeat(63), 'g'.repeat(64), 1])
            assert.throws(() => observedWindowDigest([
                row(5, { ledger_hash: value }),
            ], 5, 5), /64-character hashes or null/);

        assert.throws(() => observedWindowDigest([row(5)], 5, 6), /contiguous/);
        assert.throws(() => observedWindowDigest([row(6)], 5, 5), /contiguous/);
        assert.throws(() => observedWindowDigest([row(5), row(7)], 5, 6), /contiguous/);
    });

    it('reads all digest fields with one deterministically ordered query', async function(){
        let query;
        let params;
        const rows = [row(5)];
        const db = {
            async doQueryStrict(sql, values){
                query = sql;
                params = values;
                return rows;
            },
        };

        assert.strictEqual(await readReplayWitnessBlocks(db, 5, 5), rows);
        for(const field of ['block_hash', 'ledger_hash', 'actions_hash', 'contract_hash', 'state_root'])
            assert.match(query, new RegExp('\\b' + field + '\\b'));
        assert.match(query, /LEFT JOIN index_transactions t1/);
        assert.match(query, /LEFT JOIN index_transactions t2/);
        assert.match(query, /LEFT JOIN index_transactions t3/);
        assert.match(query, /LEFT JOIN state_tree_roots str/);
        assert.match(query, /ORDER BY b\.block_index ASC, b\.id ASC/);
        assert.deepStrictEqual(params, [5, 5]);
    });

    it('accepts diverged witness phases', function(){
        assert.ok(REPLAY_WITNESS_PHASES.includes('diverged'));
        const phase = {
            phase: 'diverged',
            target: 5,
            replay_to: 6,
            rules_from: hash('f'),
            window_count: 1,
            map_count: 0,
        };
        assert.strictEqual(decodeReplayWitnessPhase(phase), phase);
    });
});

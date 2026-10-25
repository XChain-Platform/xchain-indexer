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
 * CLI coverage for retroactive rewitness argument validation.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');

const { canonical } = require('../../../../../src/consensus_rules_digest.js');
const { buildReplayWitness } = require(
    '../../../../../src/consensus/retroactive/replay_witness.js'
);
const {
    REPLAY_WITNESS_PHASE_CODE,
    encodedRows,
} = require('../../../../../src/db/events/retroactive_replay_witness.js');
const { main } = require('../../../../../bin/retroactive-go.js');

const TARGET = 40;
const REPLAY_TO = 44;
const GATE_HEIGHTS = { 'example.ACTIVATION': 200 };
const RULES_FROM = crypto.createHash('sha256').update(canonical(GATE_HEIGHTS)).digest('hex');

function rewitnessDb(){
    const witness = buildReplayWitness({
        target: TARGET,
        replayTo: REPLAY_TO,
        rulesFrom: RULES_FROM,
        gateHeights: GATE_HEIGHTS,
        blocks: Array.from({ length: REPLAY_TO - TARGET + 1 }, (_, offset) => ({
            block_index: TARGET + offset,
            block_hash: String(TARGET + offset).padStart(64, '0'),
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
    return { db, inserts };
}

describe('retroactive-go rewitness arguments @regression @tier1', function(){
    it('accepts bare --rewitness for the open marker target', async function(){
        const fixture = rewitnessDb();

        const result = await main(['--rewitness'], { db: fixture.db, write(){} });

        assert.strictEqual(result.target, TARGET);
        assert.strictEqual(fixture.inserts.length, 1);
        assert.strictEqual(fixture.inserts[0][0], REPLAY_WITNESS_PHASE_CODE);
    });

    it('accepts --rewitness with the open marker target', async function(){
        const fixture = rewitnessDb();

        const result = await main(['--rewitness', '--target', String(TARGET)], {
            db: fixture.db,
            write(){},
        });

        assert.strictEqual(result.target, TARGET);
        assert.strictEqual(fixture.inserts.length, 1);
        assert.strictEqual(fixture.inserts[0][0], REPLAY_WITNESS_PHASE_CODE);
    });

    it('refuses --rewitness with a target that does not match the open marker', async function(){
        const fixture = rewitnessDb();

        await assert.rejects(
            main(['--rewitness', '--target', String(TARGET + 1)], {
                db: fixture.db,
                write(){},
            }),
            /rewitness target 41 does not match open replay target 40/
        );
        assert.strictEqual(fixture.inserts.length, 0);
    });
});

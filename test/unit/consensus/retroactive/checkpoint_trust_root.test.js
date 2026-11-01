/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Unit coverage for refusing superseded checkpoint trust roots.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const {
    CHECKPOINT_SUPERSEDED,
    assertNotSuperseded,
} = require('../../../../src/consensus/retroactive/checkpoint_trust_root.js');
const {
    supersededBySeq,
} = require('../../../../src/consensus/retroactive/checkpoint_supersede.js');

const row = (checkpointSeq, blockIndex, supersedesFrom, network = 'regtest') => ({
    chain: 'BTC',
    network,
    checkpoint_seq: checkpointSeq,
    block_index: blockIndex,
    supersedes_from: supersedesFrom === undefined ? null : supersedesFrom,
});

function caught(run){
    try{
        run();
        return null;
    }catch(error){
        return error;
    }
}

describe('checkpoint trust-root supersession refusal @regression @tier1', function () {
    const rows = [
        row(10, 50),
        row(20, 60),
        row(30, 70, 55),
        row(25, 65, '50'),
        row(40, 90, 95, 'testnet'),
    ];

    it('accepts a live row and a superseding row', function () {
        assert.strictEqual(assertNotSuperseded(row(26, 40), rows), undefined);
        assert.strictEqual(assertNotSuperseded(rows[2], rows), undefined);
    });

    it('refuses rows at and above supersedes_from with the lowest superseding seq', function () {
        for(const candidate of [rows[0], rows[1]]){
            const error = caught(() => assertNotSuperseded(candidate, rows));
            assert(error instanceof Error);
            assert.strictEqual(error.code, CHECKPOINT_SUPERSEDED);
            assert.strictEqual(error.superseded_by_seq, 25);
            assert.strictEqual(error.superseded_by_seq, supersededBySeq(candidate, rows));
            assert.strictEqual(error.supersedes_from, 50);
            assert.match(error.message, /BTC:regtest checkpoint_seq \d+ is superseded_by_seq 25/);
        }
    });

    it('reports a string supersedes_from as a Number', function () {
        const error = caught(() => assertNotSuperseded(rows[3], rows));
        assert(error instanceof Error);
        assert.strictEqual(error.code, CHECKPOINT_SUPERSEDED);
        assert.strictEqual(error.superseded_by_seq, 30);
        assert.strictEqual(error.superseded_by_seq, supersededBySeq(rows[3], rows));
        assert.strictEqual(error.supersedes_from, 55);
        assert.strictEqual(typeof error.supersedes_from, 'number');
    });

    it('ignores a superseder on another network', function () {
        assert.strictEqual(assertNotSuperseded(row(31, 96), rows), undefined);
        const candidate = row(31, 96, null, 'testnet');
        const error = caught(() => assertNotSuperseded(candidate, rows));
        assert(error instanceof Error);
        assert.strictEqual(error.code, CHECKPOINT_SUPERSEDED);
        assert.strictEqual(error.superseded_by_seq, 40);
        assert.strictEqual(error.superseded_by_seq, supersededBySeq(candidate, rows));
        assert.match(error.message, /BTC:testnet checkpoint_seq 31 is superseded_by_seq 40/);
    });

    it('does not mutate the row or rows inputs', function () {
        const candidate = row(10, 50);
        const candidateBefore = JSON.stringify(candidate);
        const rowsBefore = JSON.stringify(rows);
        assert.throws(() => assertNotSuperseded(candidate, rows));
        assert.strictEqual(JSON.stringify(candidate), candidateBefore);
        assert.strictEqual(JSON.stringify(rows), rowsBefore);
    });
});

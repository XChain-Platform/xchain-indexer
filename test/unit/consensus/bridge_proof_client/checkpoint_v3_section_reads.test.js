/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * test/unit/consensus/bridge_proof_client/checkpoint_v3_section_reads.test.js
 *
 * The earliest-valid-checkpoint reads take their section version as a number or a
 * list of numbers and bind a.version IN (?, ...) with one placeholder per version.
 * Each read's SQL and params are captured through a stub doQueryStrict.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../../fixtures/config');
const Utility           = require('../../../../src/utility');
const Database          = require('../../../../src/db');

function capture() {
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
    const calls = [];
    sinon.stub(db, 'doQueryStrict').callsFake(async (sql, params) => { calls.push({ sql, params }); return []; });
    return { db, calls };
}

const READS = [
    { name: 'getEarliestValidAnchorCheckpoint',           height: 700 },
    { name: 'getEarliestValidAnchorCheckpointAfterAnchor', height: 800 }
];

describe('getEarliestValidAnchorCheckpoint reads bind the section version list @regression @tier1', function () {
    afterEach(() => sinon.restore());

    for (const { name, height } of READS) {
        describe(name, function () {
            it('binds both versions of [0, 3] ahead of chain, network and height', async function () {
                const { db, calls } = capture();
                await db[name]([0, 3], 'BTC', 'regtest', height);
                assert.strictEqual(calls.length, 1);
                assert.ok(calls[0].sql.includes('a.version IN (?, ?)'));
                assert.deepStrictEqual(calls[0].params, [0, 3, 'BTC', 'regtest', height]);
            });

            it('binds a single 0 for the number 0', async function () {
                const { db, calls } = capture();
                await db[name](0, 'BTC', 'regtest', height);
                assert.ok(calls[0].sql.includes('a.version IN (?)'));
                assert.deepStrictEqual(calls[0].params, [0, 'BTC', 'regtest', height]);
            });

            it('binds a single 0 for [0]', async function () {
                const { db, calls } = capture();
                await db[name]([0], 'BTC', 'regtest', height);
                assert.ok(calls[0].sql.includes('a.version IN (?)'));
                assert.deepStrictEqual(calls[0].params, [0, 'BTC', 'regtest', height]);
            });

            it("keeps state_root IS NOT NULL, status 'valid', the ORDER BY and LIMIT 1", async function () {
                const { db, calls } = capture();
                await db[name]([0, 3], 'BTC', 'regtest', height);
                const sql = calls[0].sql;
                assert.ok(sql.includes('state_root IS NOT NULL'));
                assert.ok(sql.includes("s.status = 'valid'"));
                assert.ok(/ORDER BY a\.(block_index|snapshot_block) ASC, a\.checkpoint_seq DESC, a\.action_index ASC, a\.section_index ASC/.test(sql));
                assert.ok(/LIMIT 1\s*$/.test(sql));
            });
        });
    }
});

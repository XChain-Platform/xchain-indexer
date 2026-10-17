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
 * The anchor reward copy record never holds the mirror drain. applyRow writes each applied
 * anchor_reward_attestations row to anchor_reward_attestation_copies as well
 * (hub_db_sync/apply/attestation_copies.js): a failing copy write leaves the main row applied,
 * is counted in mirrorStatus().attestationCopyFailures and logged once per distinct error, and
 * a schema without the copies table is probed once, not once per row.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

const ROW = { id: 7, chain: 'DOGE', network: 'regtest', reward_type: 'anchor_bundle', round_reference: 20,
              snapshot_block: 20, publisher: 'ab'.repeat(32), reward_amount: '10',
              publisher_attestations: '[]', doge_anchor_txid: '11'.repeat(32) };
const MAIN_COLS = new Set(['id'].concat(Object.keys(ROW)));

// A sync whose hub DB records every statement; `copies` decides the copies table:
// 'throws' fails every copy write, 'missing' has no such table.
function makeSync(copies) {
    const writes = [], probes = [];
    const hubDb = {
        doQuery: sinon.stub().resolves([]),
        doQueryStrict: sinon.stub().callsFake(async (sql) => {
            if (/INTO anchor_reward_attestation_copies /.test(sql)) {
                if (copies === 'throws') throw new Error('copies write refused');
                writes.push('copy');
                return { affectedRows: 1 };
            }
            writes.push('main');
            return { affectedRows: 1 };
        }),
    };
    const sync = new HubDbSync(hubDb, { hubUrl: 'http://hub.test', network: 'regtest' });
    sinon.stub(sync, 'localColumns').callsFake(async (table) => {
        if (table === 'anchor_reward_attestation_copies') {
            probes.push(table);
            if (copies === 'missing') throw new Error('local mirror table ' + table + ' not available yet (no columns)');
            return new Set(['copy_digest']);
        }
        return MAIN_COLS;
    });
    return { sync, writes, probes };
}

describe('HubDbSync anchor reward copies never hold the drain @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('applies the main row when the copy write throws, counts it, and warns once per distinct error', async function () {
        const { sync, writes } = makeSync('throws');
        for (let i = 0; i < 3; i++) await sync.applyRow('anchor_reward_attestations', Object.assign({}, ROW, { round_reference: 20 + i }));
        assert.deepStrictEqual(writes, ['main', 'main', 'main']);
        assert.strictEqual(sync._attestationCopies.failures, 3);
        // Three failures with one error text: one entry in the warned set, so one warning.
        assert.deepStrictEqual([...sync._attestationCopies.warned], ['copies write refused']);
        assert.strictEqual(sync.mirrorStatus().attestationCopyFailures, 3);
    });

    it('probes a missing copies table once and still applies every main row', async function () {
        const { sync, writes, probes } = makeSync('missing');
        for (let i = 0; i < 3; i++) await sync.applyRow('anchor_reward_attestations', Object.assign({}, ROW, { round_reference: 20 + i }));
        assert.deepStrictEqual(writes, ['main', 'main', 'main']);
        assert.strictEqual(probes.length, 1);
        assert.strictEqual(sync._attestationCopies.failures, 0);
    });

    it('records the copy beside the main row when the table is present', async function () {
        const { sync, writes } = makeSync('present');
        await sync.applyRow('anchor_reward_attestations', ROW);
        assert.deepStrictEqual(writes, ['main', 'copy']);
    });
});

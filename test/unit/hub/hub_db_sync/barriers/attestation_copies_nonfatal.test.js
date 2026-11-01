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
 * Anchor reward copy writes stay best effort for non-deriving consumers, while a BTC indexer
 * fails closed so its drain cursor cannot advance over a missing consensus input.
 */

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');

const ROW = { id: 7, chain: 'DOGE', network: 'regtest', reward_type: 'anchor_bundle', round_reference: 20,
              snapshot_block: 20, publisher: 'ab'.repeat(32), reward_amount: '10',
              publisher_attestations: '[]', doge_anchor_txid: '11'.repeat(32) };
const MAIN_COLS = new Set(['id'].concat(Object.keys(ROW)));

// A sync whose hub DB records every statement; mode decides the probe and copy writes.
function makeSync(initialMode, deriving = false) {
    const writes = [], probes = [];
    let mode = initialMode;
    const hubDb = {
        doQuery: sinon.stub().resolves([]),
        doQueryStrict: sinon.stub().callsFake(async (sql) => {
            if (/information_schema\.TABLES/.test(sql)) {
                probes.push('anchor_reward_attestation_copies');
                if (mode === 'probe-once' && probes.length === 1) throw new Error('probe interrupted');
                return mode === 'missing' ? [] : [{ TABLE_NAME: 'anchor_reward_attestation_copies' }];
            }
            if (/INTO anchor_reward_attestation_copies /.test(sql)) {
                if (mode === 'throws') throw new Error('copies write refused');
                writes.push('copy');
                return { affectedRows: 1 };
            }
            writes.push('main');
            return { affectedRows: 1 };
        }),
    };
    if (deriving) hubDb.indexer = { indexerDb: {} };
    const sync = new HubDbSync(hubDb, {
        hubUrl: 'enabled', network: 'regtest', coin: deriving ? 'BTC' : 'DOGE'
    });
    sinon.stub(sync, 'localColumns').callsFake(async (table) => {
        return MAIN_COLS;
    });
    return { sync, writes, probes, setMode(next) { mode = next; } };
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

describe('HubDbSync BTC anchor reward copies fail closed @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('rejects a copy write failure and succeeds when the same row is retried', async function () {
        const { sync, writes, setMode } = makeSync('throws', true);
        await assert.rejects(sync.applyRow('anchor_reward_attestations', ROW), /copies write refused/);
        assert.deepStrictEqual(writes, ['main']);
        assert.strictEqual(sync._attestationCopies.failures, 1);

        setMode('present');
        await sync.applyRow('anchor_reward_attestations', ROW);
        assert.deepStrictEqual(writes, ['main', 'main', 'copy']);
    });

    it('rejects when the copies table is confirmed absent', async function () {
        const { sync, writes, probes } = makeSync('missing', true);
        await assert.rejects(sync.applyRow('anchor_reward_attestations', ROW),
            /required for BTC anchor-reward derivation/);
        assert.deepStrictEqual(writes, ['main']);
        assert.strictEqual(probes.length, 1);
    });

    it('does not cache a transient table-probe failure as a missing table', async function () {
        const { sync, writes, probes } = makeSync('probe-once', true);
        await sync.applyRow('anchor_reward_attestations', ROW);
        await sync.applyRow('anchor_reward_attestations', Object.assign({}, ROW, { round_reference: 21 }));
        assert.deepStrictEqual(writes, ['main', 'copy', 'main', 'copy']);
        assert.strictEqual(probes.length, 2);
    });

    it('keeps the bootstrap cursor before a row whose copy write fails', async function () {
        const { sync } = makeSync('throws', true);
        const drain = {
            table: 'anchor_reward_attestations', lastId: 6, applied: 0, applyErrors: 0,
            priceSkipped: 0, priceHorizon: 0, minAppliedWireId: Infinity
        };
        sinon.stub(sync, 'decidePriceBound').returns(false);
        sinon.stub(sync, 'recordServedRow');
        assert.strictEqual(await sync.applyPendingRow(drain, ROW, false), false);
        assert.strictEqual(drain.lastId, 6);
        assert.strictEqual(drain.applyErrors, 1);
    });
});

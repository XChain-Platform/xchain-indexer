// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const AnchorRecovery = require('../../../../bin/recovery.js');
const bridgePolicy = require('../../../../bin/recovery/bridge_policy.js');
const { makeKeypair, buildBatch, rawMatch, rawBridge } = require('../../../fixtures/anchor-archive.js');
const { util, memDb } = require('../../../helpers/recovery_stubs.js');

const quiet = { log: () => {}, util };
const ID = 'a'.repeat(64);

describe('AnchorRecovery revived bridge transfers @regression @tier2', function () {
    let oracleKeys, crossKeys;
    beforeEach(function () {
        oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        crossKeys  = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
    });

    it('takes the revive round content across finalized, retracted, finalized batches', async function () {
        let v1 = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
            { bridges: [rawBridge(ID, 'finalized')], bridgeSigners: 3 });
        let gone = buildBatch(1, [rawMatch('m2')], oracleKeys, crossKeys,
            { bridges: [rawBridge(ID, 'retracted')], bridgeSigners: 3 });
        let v2Row = { effective_time: 1700000500, finalizing_view: 2 };
        let v2 = buildBatch(2, [rawMatch('m3')], oracleKeys, crossKeys,
            { bridges: [rawBridge(ID, 'finalized', v2Row)], bridgeSigners: 4 });
        let db = memDb([v1.v1, gone.v1, v2.v1], v1.v2s.concat(gone.v2s, v2.v2s));
        let report = await new AnchorRecovery(db, quiet).run();

        let archived = await new AnchorRecovery(memDb([], []), quiet).verifyBatch(v2.v1);
        let want = archived.bridge_transfers[0];
        assert.strictEqual(report.verified, 3);
        assert.strictEqual(db.bridges.length, 1);
        assert.strictEqual(db.bridges[0].status, 'finalized');
        assert.strictEqual(db.bridges[0].effective_time, 1700000500);
        assert.strictEqual(db.bridges[0].finalizing_view, 2);
        assert.strictEqual(db.bridges[0].validator_signatures, want.validator_signatures);
        assert.strictEqual(JSON.parse(want.validator_signatures).length, 4);
    });

    it('overwrites snapshot_block and every revive column on a finalized row that already exists', async function () {
        let db = memDb([], []);
        let report = { bridges: 0, policies: 0 };
        let first = rawBridge(ID, 'finalized', { validator_signatures: '[{"v":1}]' });
        let revived = rawBridge(ID, 'finalized', {
            snapshot_block: 101, effective_time: 1700000500, finalizing_view: 2,
            validator_signatures: '[{"v":2}]'
        });
        await bridgePolicy.writeArchive(db, { bridge_transfers: [first] }, report);
        await bridgePolicy.writeArchive(db, { bridge_transfers: [Object.assign({}, first, { status: 'retracted' })] }, report);
        assert.strictEqual(db.bridges[0].snapshot_block, 100);
        await bridgePolicy.writeArchive(db, { bridge_transfers: [revived] }, report);

        assert.strictEqual(db.bridges.length, 1);
        assert.deepStrictEqual(
            [db.bridges[0].status, db.bridges[0].snapshot_block, db.bridges[0].effective_time,
             db.bridges[0].finalizing_view, db.bridges[0].validator_signatures],
            ['finalized', 101, 1700000500, 2, '[{"v":2}]']);
        assert.strictEqual(db.bridges[0].amount, first.amount, 'the signed terms are never rewritten');
    });

    it('keeps a retraction status-only so it never rewrites the finalized content', async function () {
        let db = memDb([], []);
        let report = { bridges: 0, policies: 0 };
        let first = rawBridge(ID, 'finalized', { validator_signatures: '[{"v":1}]' });
        await bridgePolicy.writeArchive(db, { bridge_transfers: [first] }, report);
        let retraction = rawBridge(ID, 'retracted', {
            snapshot_block: 105, effective_time: 1, finalizing_view: 9, validator_signatures: '[]'
        });
        await bridgePolicy.writeArchive(db, { bridge_transfers: [retraction] }, report);

        assert.deepStrictEqual(
            [db.bridges[0].status, db.bridges[0].snapshot_block, db.bridges[0].effective_time,
             db.bridges[0].finalizing_view, db.bridges[0].validator_signatures],
            ['retracted', 100, 1700000010, 0, '[{"v":1}]']);
    });
});

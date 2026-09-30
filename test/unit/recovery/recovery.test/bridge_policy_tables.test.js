'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const AnchorRecovery = require('../../../../bin/recovery.js');
const {
    makeKeypair, buildBatch, rawMatch, rawBridge, rawPolicy,
    BRIDGE_KEYS, POLICY_KEYS
} = require('../../../fixtures/anchor-archive.js');
const { util, memDb } = require('../../../helpers/recovery_stubs.js');

let oracleKeys, crossKeys;
function freshKeys() {
    oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
    crossKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
}
const quiet = { log: () => {}, util };

class PreBridgePolicyWriterRecovery extends AnchorRecovery {
    async writeBatch(archive, report, network, anchorTxid, rewards) {
        let legacy = Object.assign({}, archive);
        delete legacy.bridge_transfers;
        delete legacy.policy_snapshots;
        return super.writeBatch(legacy, report, network, anchorTxid, rewards);
    }
}

describe('AnchorRecovery bridge and policy tables @regression @tier2', function () {
    beforeEach(freshKeys);

    it('uses the ABP archive key orders and only the full writer restores both tables', async function () {
        let bridge = rawBridge('a'.repeat(64), 'finalized');
        let policy = rawPolicy('b'.repeat(64));
        let batch = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
            { bridges: [bridge], policies: [policy] });

        let legacyDb = memDb([batch.v1], batch.v2s);
        let legacyReport = await new PreBridgePolicyWriterRecovery(legacyDb, quiet).run();
        assert.strictEqual(legacyReport.verified, 1);
        assert.strictEqual(legacyDb.matches.length, 1, 'the pre-change match writer still runs');
        assert.strictEqual(legacyDb.bridges.length, 0, 'the pre-change writer leaves bridge_transfers empty');
        assert.strictEqual(legacyDb.policies.length, 0, 'the pre-change writer leaves policy_snapshots empty');

        let fullDb = memDb([batch.v1], batch.v2s);
        let report = await new AnchorRecovery(fullDb, quiet).run();
        assert.strictEqual(report.verified, 1);
        assert.strictEqual(report.bridges, 1);
        assert.strictEqual(report.policies, 1);
        assert.strictEqual(fullDb.bridges.length, 1);
        assert.strictEqual(fullDb.policies.length, 1);

        let dryDb = memDb([batch.v1], batch.v2s);
        let dryReport = await new AnchorRecovery(dryDb, Object.assign({ dryRun: true }, quiet)).run();
        assert.strictEqual(dryReport.bridges, 1);
        assert.strictEqual(dryReport.policies, 1);
        assert.strictEqual(dryDb.bridges.length, 0);
        assert.strictEqual(dryDb.policies.length, 0);

        let archive = await new AnchorRecovery(memDb([], []), quiet).verifyBatch(batch.v1);
        assert.deepStrictEqual(Object.keys(archive.bridge_transfers[0]), BRIDGE_KEYS);
        assert.deepStrictEqual(Object.keys(archive.policy_snapshots[0]), POLICY_KEYS);
    });

    it('latest-status-wins when a later archive retracts a transfer', async function () {
        let transferId = 'c'.repeat(64);
        let first = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
            { bridges: [rawBridge(transferId, 'finalized')] });
        let second = buildBatch(1, [rawMatch('m2')], oracleKeys, crossKeys,
            { bridges: [rawBridge(transferId, 'retracted')] });
        let db = memDb([first.v1, second.v1], first.v2s.concat(second.v2s));
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 2);
        assert.strictEqual(report.bridges, 2);
        assert.strictEqual(db.bridges.length, 1);
        assert.strictEqual(db.bridges[0].status, 'retracted');
    });

    it('rejects a forged transfer signature and writes none of the batch', async function () {
        let batch = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, {
            bridges: [rawBridge('d'.repeat(64), 'finalized')],
            policies: [rawPolicy('e'.repeat(64))],
            bridgeKeys: oracleKeys
        });
        let db = memDb([batch.v1], batch.v2s);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 0);
        assert.ok(report.failed[0].reason.includes('bridge transfer'));
        assert.ok(report.failed[0].reason.includes('fails quorum'));
        assert.strictEqual(db.matches.length, 0);
        assert.strictEqual(db.bridges.length, 0);
        assert.strictEqual(db.policies.length, 0);
    });

    it('rejects a policy list that does not hash to the signed policy_hash', async function () {
        let policy = rawPolicy('f'.repeat(64));
        policy.allow_list = JSON.stringify(['addr1', 'addr2', 'attacker']);
        let batch = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
            { bridges: [rawBridge('1'.repeat(64), 'finalized')], policies: [policy] });
        let db = memDb([batch.v1], batch.v2s);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 0);
        assert.ok(report.failed[0].reason.includes('policy_hash does not match membership lists'));
        assert.strictEqual(db.matches.length, 0);
        assert.strictEqual(db.bridges.length, 0);
        assert.strictEqual(db.policies.length, 0);
    });

    it('fails a policy sequence collision with a different snapshot id', async function () {
        let first = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys,
            { policies: [rawPolicy('2'.repeat(64))] });
        let second = buildBatch(1, [rawMatch('m2')], oracleKeys, crossKeys,
            { policies: [rawPolicy('3'.repeat(64))] });
        let db = memDb([first.v1, second.v1], first.v2s.concat(second.v2s));
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 1);
        assert.strictEqual(report.failed.length, 1);
        assert.ok(report.failed[0].reason.includes('collides with an existing policy sequence'));
        assert.deepStrictEqual(db.policies.map(row => row.snapshot_id), ['2'.repeat(64)]);
    });
});

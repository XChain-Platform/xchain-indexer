'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
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
const zlib = require('zlib');
const sinon = require('sinon');

const AnchorRecovery = require('../../../bin/recovery.js');
const archivePublish = require('../../../src/consensus/archive_publish_set.js');
const {
    makeKeypair, signHex, crc32Hex, buildBatch, rawMatch
} = require('../../fixtures/anchor-archive.js');
const {
    util, memDb, btcDbStub, capSetFromKeys
} = require('../../helpers/recovery_stubs.js');

const quiet = { log: () => {}, util };

function repack(batch, mutate, signingKeys){
    let archive = JSON.parse(zlib.gunzipSync(
        Buffer.from(batch.v1.archive_b64, 'base64url')).toString('utf8'));
    mutate(archive);

    let json = JSON.stringify(archive);
    batch.v1.batch_crc32 = crc32Hex(json);
    batch.v1.archive_b64 = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 })
        .toString('base64url');
    batch.v1.total_chunks = 1;
    let canonical = AnchorRecovery.wrapperCanonicalForTest(batch.v1);
    batch.v1.validator_signatures = JSON.stringify(signingKeys.slice(0, 3)
        .map(key => ({ pubkey: key.pubkey, sig: signHex(key, canonical) })));
    batch.v2s = [];
    return batch;
}

afterEach(function(){ sinon.restore(); });

describe('AnchorRecovery archive_publish wrapper set @regression @tier1', function(){
    it('recovers an active wrapper whose archive predates archive_publish snapshots', async function(){
        let oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        let crossKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        let batch = buildBatch(0, [rawMatch('legacy-active')], oracleKeys, crossKeys);

        let archive = await new AnchorRecovery(memDb([], []), quiet).verifyBatch(batch.v1);
        assert.strictEqual(archive.matches.length, 1);
        assert.strictEqual(archive.capability_snapshots
            .filter(row => row.capability === 'oracle_publish').length, 4);
        assert.strictEqual(archive.capability_snapshots
            .filter(row => row.capability === 'archive_publish').length, 0);
    });

    it('filters the legacy wrapper set through rolled absences in verified recovery', async function(){
        let oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        let crossKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        let batch = repack(buildBatch(0, [rawMatch('legacy-filtered')], oracleKeys, crossKeys),
            () => {}, oracleKeys.slice(1).concat(oracleKeys[0]));
        let capSets = {
            oracle_publish: capSetFromKeys(oracleKeys),
            cross_chain: capSetFromKeys(crossKeys)
        };
        let btcDb = btcDbStub(oracleKeys.concat(crossKeys).map(key => key.pubkey), { capSets });
        let absenceReads = [];
        btcDb.getLatestRolledRollcallAbsentSources = async block => {
            absenceReads.push(block);
            return ['src_' + oracleKeys[0].pubkey.slice(0, 16)];
        };

        let archive = await new AnchorRecovery(memDb([], []), {
            ...quiet, btcDb, verifyStakes: true
        }).verifyBatch(batch.v1);
        assert.strictEqual(archive.matches.length, 1);
        assert.deepStrictEqual(absenceReads, [100]);

        let weak = buildBatch(1, [rawMatch('legacy-absent-signer')], oracleKeys, crossKeys);
        await assert.rejects(
            () => new AnchorRecovery(memDb([], []), {
                ...quiet, btcDb, verifyStakes: true
            }).verifyBatch(weak.v1),
            error => error.message.includes('wrapper signatures fail quorum'));
    });

    it('recovers a post-gate wrapper against setFor archive_publish', async function(){
        let gate = sinon.spy(archivePublish, 'isArchivePublishSetActive');
        let oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        let crossKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        let batch = repack(buildBatch(0, [rawMatch('post-gate')], oracleKeys, crossKeys),
            archive => {
                for(let row of archive.capability_snapshots)
                    if(row.capability === 'oracle_publish') row.capability = 'archive_publish';
            }, oracleKeys);

        let archive = await new AnchorRecovery(memDb([], []), quiet).verifyBatch(batch.v1);
        assert.strictEqual(archive.matches.length, 1);
        assert.strictEqual(archive.capability_snapshots
            .filter(row => row.capability === 'archive_publish').length, 4);
        assert.strictEqual(archive.capability_snapshots
            .filter(row => row.capability === 'oracle_publish').length, 0);
        assert.ok(gate.calledOnceWithExactly(100, 'regtest'));
        assert.strictEqual(gate.returned(true), true);
    });

    it('does not retry a present archive_publish set against oracle_publish', async function(){
        sinon.stub(archivePublish, 'isArchivePublishSetActive').returns(true);
        let oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        let crossKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        let batch = repack(buildBatch(0, [rawMatch('present-publish-set')],
            oracleKeys, crossKeys), archive => {
            let archiveRows = archive.capability_snapshots
                .filter(row => row.capability === 'cross_chain')
                .map(row => Object.assign({}, row, { capability: 'archive_publish' }));
            archive.capability_snapshots.push(...archiveRows);
        }, oracleKeys);

        await assert.rejects(
            () => new AnchorRecovery(memDb([], []), quiet).verifyBatch(batch.v1),
            error => error.message.includes('wrapper signatures fail quorum') &&
                error.message.includes('archive_publish'));
    });

    it('keeps a pre-gate wrapper on setFor oracle_publish', async function(){
        sinon.stub(archivePublish, 'isArchivePublishSetActive').returns(false);
        let oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        let crossKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        let batch = repack(buildBatch(0, [rawMatch('pre-gate')], oracleKeys, crossKeys),
            archive => {
                let archiveRows = archive.capability_snapshots
                    .filter(row => row.capability === 'cross_chain')
                    .map(row => Object.assign({}, row, { capability: 'archive_publish' }));
                archive.capability_snapshots.push(...archiveRows);
            }, oracleKeys);

        let archive = await new AnchorRecovery(memDb([], []), quiet).verifyBatch(batch.v1);
        assert.strictEqual(archive.matches.length, 1);
        assert.strictEqual(archive.capability_snapshots
            .filter(row => row.capability === 'oracle_publish').length, 4);
        assert.strictEqual(archive.capability_snapshots
            .filter(row => row.capability === 'archive_publish').length, 4);
    });

    it('verifyCompleteness refuses archive_publish when a present source was dropped', async function(){
        let keys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        let archived = capSetFromKeys(keys.slice(0, 3));
        let present = capSetFromKeys(keys);
        let absenceBlocks = [];
        let btcDb = {
            config: null,
            async getStakeWeightsByCapability(capability, block, minStake){
                assert.strictEqual(capability, 'oracle_publish');
                assert.strictEqual(block, 94);
                assert.strictEqual(minStake, null);
                return present;
            },
            async getLatestRolledRollcallAbsentSources(block){
                absenceBlocks.push(block);
                return [];
            },
            async doQuery(){ return []; }
        };
        let snapshots = archived.map(row => ({
            capability: 'archive_publish', snapshot_block: 100,
            signing_pubkey: row.pubkey, source: row.source, amount: row.weight
        }));
        let recovery = new AnchorRecovery(memDb([], []),
            Object.assign({ btcDb }, quiet));

        await assert.rejects(
            () => recovery.verifyCompleteness(snapshots, 'regtest'),
            error => error.message.includes('archived archive_publish snapshot') &&
                error.message.includes('incomplete') && error.message.includes('was dropped'));
        assert.deepStrictEqual(absenceBlocks, [100]);
    });
});

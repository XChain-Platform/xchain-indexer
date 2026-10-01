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
const zlib = require('zlib');

const AnchorRecovery = require('../../../bin/recovery.js');
const listShare = require('../../../src/consensus/list_share_settle.js');
const { deriveListSnapshotId } = require('../../../src/consensus/list_share_settle/canonical.js');
const lifecycle = require('../../../src/hub/table_lifecycle.js');
const {
    makeKeypair, signHex, buildBatch, rawMatch, crc32Hex, SNAPSHOT_BLOCK
} = require('../../fixtures/anchor-archive.js');
const { util, memDb } = require('../../helpers/recovery_stubs.js');

const LIST_KEYS = [
    'id', 'snapshot_id', 'snapshot_block', 'network', 'home_chain',
    'home_list_index', 'list_type', 'seq', 'kind', 'origin_block',
    'members_hash', 'added', 'removed', 'admit_block_btc',
    'admit_block_ltc', 'admit_block_doge', 'finalizing_view',
    'validator_signatures', 'status'
];
const quiet = { log: () => {}, util };

let oracleKeys, crossKeys;

function freshKeys(){
    oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
    crossKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
}

function rawList(seq, overrides){
    let row = Object.assign({
        id: seq,
        snapshot_block: SNAPSHOT_BLOCK,
        network: 'regtest',
        home_chain: 'DOGE',
        home_list_index: 880001,
        list_type: 2,
        seq,
        kind: seq === 1 ? 'full' : 'delta',
        origin_block: 68000000 + seq,
        members_hash: String(seq).repeat(64),
        added: JSON.stringify(seq === 1 ? ['addr-a', 'addr-b'] : ['addr-c']),
        removed: JSON.stringify(seq === 1 ? [] : ['addr-a']),
        admit_block_btc: 160010 + seq,
        admit_block_ltc: 4905000 + seq,
        admit_block_doge: 68000010 + seq,
        finalizing_view: seq - 1,
        status: 'finalized'
    }, overrides || {});
    row.snapshot_id = deriveListSnapshotId(
        row.network, row.home_chain, row.home_list_index, row.seq, row.snapshot_block);
    return row;
}

function signList(row, keys){
    let signed = Object.assign({}, row);
    let canonical = listShare.listShareCanonical(signed);
    signed.validator_signatures = JSON.stringify(keys.slice(0, 3).map(key => ({
        pubkey: key.pubkey,
        sig: signHex(key, canonical)
    })));
    return signed;
}

function archiveWithLists(batchSeq, rows, listKeys){
    let batch = buildBatch(batchSeq, [rawMatch('match-' + batchSeq)], oracleKeys, crossKeys);
    let archive = JSON.parse(zlib.gunzipSync(
        Buffer.from(batch.v1.archive_b64, 'base64url')).toString('utf8'));
    archive.list_snapshots = rows.map(row => signList(row, listKeys || crossKeys));

    let json = JSON.stringify(archive);
    let v1 = Object.assign({}, batch.v1, {
        archive_b64: zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64url'),
        batch_crc32: crc32Hex(json),
        total_chunks: 1
    });
    let recovery = new AnchorRecovery({ doQuery: async () => [] }, quiet);
    let canonical = recovery.wrapperCanonical(v1);
    v1.validator_signatures = JSON.stringify(oracleKeys.slice(0, 3).map(key => ({
        pubkey: key.pubkey,
        sig: signHex(key, canonical)
    })));
    return { v1, v2s: [] };
}

function listMemDb(v1s, v2s, initial){
    let db = memDb(v1s, v2s);
    let query = db.doQuery.bind(db);
    db.lists = (initial || []).map(row => Object.assign({}, row));
    db.doQuery = async (sql, params) => {
        let normalized = String(sql).replace(/\s+/g, ' ').trim();
        if(normalized.startsWith('SELECT snapshot_id FROM list_snapshots WHERE snapshot_id')){
            return db.lists.filter(row => row.snapshot_id === params[0])
                .map(row => ({ snapshot_id: row.snapshot_id }));
        }
        if(normalized.startsWith('SELECT snapshot_id FROM list_snapshots WHERE network')){
            return db.lists.filter(row => row.network === params[0] &&
                row.home_chain === params[1] &&
                Number(row.home_list_index) === Number(params[2]) &&
                Number(row.seq) === Number(params[3]))
                .map(row => ({ snapshot_id: row.snapshot_id }));
        }
        if(normalized.startsWith('INSERT IGNORE INTO list_snapshots')){
            let incoming = {};
            LIST_KEYS.forEach((key, index) => { incoming[key] = params[index]; });
            let duplicate = db.lists.some(row => row.snapshot_id === incoming.snapshot_id ||
                (row.network === incoming.network && row.home_chain === incoming.home_chain &&
                 Number(row.home_list_index) === Number(incoming.home_list_index) &&
                 Number(row.seq) === Number(incoming.seq)));
            if(!duplicate) db.lists.push(incoming);
            return [];
        }
        return query(sql, params);
    };
    return db;
}

describe('AnchorRecovery list snapshots @regression @tier2', function () {
    beforeEach(freshKeys);

    it('registers list_snapshots for archive recovery', function () {
        let row = lifecycle.entry('list_snapshots');
        assert.strictEqual(row.anchorRecovery, 'archive');
        assert.strictEqual(row.anchorRecoveryNote, undefined);
        assert.ok(lifecycle.anchorRecoveryTables().includes('list_snapshots'));
    });

    it('restores quorum-signed full and delta rows byte for byte', async function () {
        let rows = [rawList(1), rawList(2)];
        let batch = archiveWithLists(0, rows);
        let expected = rows.map(row => signList(row, crossKeys));
        let db = listMemDb([batch.v1], batch.v2s);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 1, JSON.stringify(report.failed));
        assert.strictEqual(report.lists, 2);
        assert.deepStrictEqual(db.lists, expected);

        let dryDb = listMemDb([batch.v1], batch.v2s);
        let dryReport = await new AnchorRecovery(
            dryDb, Object.assign({ dryRun: true }, quiet)).run();
        assert.strictEqual(dryReport.lists, 2);
        assert.deepStrictEqual(dryDb.lists, []);
    });

    it('refuses a list row signed outside the archived cross_chain set', async function () {
        let batch = archiveWithLists(0, [rawList(1)], oracleKeys);
        let db = listMemDb([batch.v1], batch.v2s);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 0);
        assert.match(report.failed[0].reason, /list snapshot .* fails quorum/);
        assert.deepStrictEqual(db.lists, []);
        assert.deepStrictEqual(db.matches, []);
    });

    it('refuses a list row from a network other than the archive head', async function () {
        let batch = archiveWithLists(0, [rawList(1, { network: 'testnet' })]);
        let db = listMemDb([batch.v1], batch.v2s);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 0);
        assert.match(report.failed[0].reason, /network does not match archive head/);
        assert.deepStrictEqual(db.lists, []);
        assert.deepStrictEqual(db.matches, []);
    });

    it('fails when the natural list sequence already has another snapshot id', async function () {
        let row = rawList(1);
        let batch = archiveWithLists(0, [row]);
        let existing = Object.assign({}, row, { snapshot_id: 'f'.repeat(64) });
        let db = listMemDb([batch.v1], batch.v2s, [existing]);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 0);
        assert.match(report.failed[0].reason, /collides with an existing list sequence/);
        assert.deepStrictEqual(db.lists, [existing]);
        assert.deepStrictEqual(db.matches, []);
    });

    it('restores a legacy archive with no list_snapshots exactly as before', async function () {
        let batch = buildBatch(0, [rawMatch('legacy-match')], oracleKeys, crossKeys);
        let db = listMemDb([batch.v1], batch.v2s);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 1, JSON.stringify(report.failed));
        assert.strictEqual(report.lists, 0);
        assert.deepStrictEqual(db.lists, []);
        assert.strictEqual(db.matches.length, 1);
        assert.strictEqual(db.matches[0].match_id, 'legacy-match');
    });
});

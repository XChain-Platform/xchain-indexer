'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// AnchorRecovery round-trip: build an archive batch exactly as the hub's
// StateAnchorPublisher serializes it (fixed key order, gzip+base64url, CRC32,
// chunking, REAL Ed25519 signatures), feed it through a mocked anchor_actions
// table, and assert cross_chain_matches + capability_snapshots rebuild — plus
// the failure modes: CRC corruption, sub-quorum wrapper, fabricated validator
// sets (the on-chain stake cross-check), and latest-status-wins retraction.

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const zlib   = require('zlib');

const AnchorRecovery = require('../../src/recovery.js');

// ── Real Ed25519 helpers ────────────────────────────────────────────────────
function makeKeypair() {
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubkey: publicKey.export({ format: 'der', type: 'spki' }).slice(12).toString('hex'), privateKey };
}
function signHex(kp, payload) {
    return crypto.sign(null, Buffer.from(payload, 'utf8'), kp.privateKey).toString('hex');
}

// ── Publisher-faithful serialization (MATCH_KEYS order) ─────────────────────
const MATCH_KEYS = ['match_id', 'snapshot_block', 'network',
    'a_chain', 'a_action_index', 'a_kind', 'a_tick', 'a_amount', 'a_filled_before', 'a_ownership', 'a_payout_addr',
    'b_chain', 'b_action_index', 'b_kind', 'b_tick', 'b_amount', 'b_filled_before', 'b_ownership', 'b_payout_addr',
    'effective_time', 'validator_signatures', 'status'];
function serializeMatch(m) {
    let out = {};
    for (let k of MATCH_KEYS) {
        let v = m[k];
        if (k === 'a_action_index' || k === 'b_action_index' || k === 'snapshot_block' || k === 'effective_time') out[k] = Number(v);
        else if (k === 'a_ownership' || k === 'b_ownership') out[k] = Number(v) ? 1 : 0;
        else if (k === 'a_tick' || k === 'b_tick') out[k] = (v == null) ? null : String(v);
        else out[k] = String(v == null ? '' : v);
    }
    return out;
}
function matchCanonical(m) {
    return ['XMATCH', m.match_id, String(m.snapshot_block),
        m.a_chain, String(m.a_action_index), m.a_tick || '', String(m.a_amount), String(m.a_ownership), m.a_payout_addr,
        m.b_chain, String(m.b_action_index), m.b_tick || '', String(m.b_amount), String(m.b_ownership), m.b_payout_addr,
        String(m.effective_time), m.network || '',
        m.a_kind || 'swap', String(m.a_filled_before != null ? m.a_filled_before : '0'),
        m.b_kind || 'swap', String(m.b_filled_before != null ? m.b_filled_before : '0')].join('|');
}
function crc32Hex(str) {
    let buf = Buffer.from(str, 'utf8');
    let n;
    if (zlib.crc32) n = zlib.crc32(buf);
    else {
        let c, crc = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) {
            c = (crc ^ buf[i]) & 0xFF;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            crc = (crc >>> 8) ^ c;
        }
        n = (crc ^ 0xFFFFFFFF) >>> 0;
    }
    return (n >>> 0).toString(16).padStart(8, '0');
}

const SNAPSHOT_BLOCK = 100;
const CP = { chain: 'BTC', network: 'regtest', block_index: 494, block_hash: 'c0'.repeat(32),
             ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
             checkpoint_seq: 7 };

// Build a full signed batch: match rows signed by crossKeys, archive JSON with
// both capability sets, wrapper v1 (+ optional v2 chunks) signed by oracleKeys.
function buildBatch(batchSeq, rawMatches, oracleKeys, crossKeys, opts) {
    opts = opts || {};
    let matches = rawMatches.map(rm => {
        let m = Object.assign({}, rm);
        let canon = matchCanonical(m);
        m.validator_signatures = JSON.stringify(crossKeys.slice(0, opts.matchSigners || 3)
            .map(kp => ({ pubkey: kp.pubkey, sig: signHex(kp, canon) })));
        return serializeMatch(m);
    });
    let snaps = [];
    for (let kp of crossKeys)  snaps.push({ snapshot_block: SNAPSHOT_BLOCK, capability: 'cross_chain',    signing_pubkey: kp.pubkey, amount: '5' });
    for (let kp of oracleKeys) snaps.push({ snapshot_block: SNAPSHOT_BLOCK, capability: 'oracle_publish', signing_pubkey: kp.pubkey, amount: '5' });
    let json = JSON.stringify({ v: 1, network: 'regtest', batch_seq: batchSeq, matches: matches, capability_snapshots: snaps });
    let crc  = crc32Hex(json);
    let b64  = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64url');

    let chunkSize   = opts.chunkSize || b64.length;
    let chunks      = [];
    for (let i = 0; i < b64.length; i += chunkSize) chunks.push(b64.slice(i, i + chunkSize));
    let totalChunks = chunks.length;

    let wrapperCanonical = ['XCHECKPOINT', CP.chain, CP.network, String(CP.block_index), CP.block_hash,
        CP.ledger_hash, CP.actions_hash, CP.contract_hash, String(CP.checkpoint_seq), String(SNAPSHOT_BLOCK),
        String(batchSeq), String(matches.length), crc, String(totalChunks)].join('|');
    let wrapperSigs = oracleKeys.slice(0, opts.wrapperSigners || 3)
        .map(kp => ({ pubkey: kp.pubkey, sig: signHex(kp, wrapperCanonical) }));

    let v1 = Object.assign({}, CP, {
        version: 1, snapshot_block: SNAPSHOT_BLOCK, match_batch_seq: batchSeq,
        match_count: matches.length, batch_crc32: (opts.corruptCrc ? 'deadbeef' : crc),
        total_chunks: totalChunks, archive_b64: chunks[0],
        validator_signatures: JSON.stringify(wrapperSigs)
    });
    let v2s = chunks.slice(1).map((c, i) => ({ version: 2, match_batch_seq: batchSeq, chunk_index: i + 1, total_chunks: totalChunks, archive_b64: c }));
    return { v1, v2s };
}

function rawMatch(id, status) {
    return { match_id: id, snapshot_block: SNAPSHOT_BLOCK, network: 'regtest',
        a_chain: 'LTC', a_action_index: 5, a_kind: 'swap', a_tick: 'TOKA', a_amount: '1000',
        a_filled_before: '0', a_ownership: 0, a_payout_addr: 'Lpay',
        b_chain: 'DOGE', b_action_index: 8, b_kind: 'swap', b_tick: null, b_amount: '2000',
        b_filled_before: '0', b_ownership: 0, b_payout_addr: 'Dpay',
        effective_time: 1700000000, status: status || 'finalized' };
}

// In-memory DOGE indexer DB for the recovery query surface.
function memDb(v1s, v2s) {
    let matches = [], snapshots = [];
    return {
        matches, snapshots,
        async doQuery(sql, params) {
            params = params || [];
            if (sql.startsWith('SELECT * FROM anchor_actions WHERE version = 1')) return v1s;
            if (sql.startsWith('SELECT chunk_index, archive_b64 FROM anchor_actions WHERE version = 2'))
                return v2s.filter(c => Number(c.match_batch_seq) === Number(params[0]));
            if (sql.startsWith('INSERT IGNORE INTO capability_snapshots')) {
                let [snapshot_block, capability, signing_pubkey, amount] = params;
                if (!snapshots.some(r => r.snapshot_block === snapshot_block && r.capability === capability && r.signing_pubkey === signing_pubkey))
                    snapshots.push({ snapshot_block, capability, signing_pubkey, amount });
                return [];
            }
            if (sql.startsWith('SELECT match_id FROM cross_chain_matches'))
                return matches.filter(r => r.match_id === params[0]).map(r => ({ match_id: r.match_id }));
            if (sql.startsWith('UPDATE cross_chain_matches SET status')) {
                for (let r of matches) if (r.match_id === params[1]) r.status = params[0];
                return [];
            }
            if (sql.startsWith('INSERT INTO cross_chain_matches')) {
                matches.push({ match_id: params[0], status: params[21] });
                return [];
            }
            return [];
        }
    };
}

// BTC indexer stub: every pubkey in `staked` holds an active stake.
function btcDbStub(staked) {
    let set = new Set(staked.map(p => p.toLowerCase()));
    return { async doQuery(sql, params) { return set.has(String(params[0]).toLowerCase()) ? [{ 1: 1 }] : []; } };
}

describe('AnchorRecovery (full-parse recovery) @regression @tier2', function () {
    let oracleKeys, crossKeys;
    const quiet = { log: () => {} };

    beforeEach(function () {
        oracleKeys = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
        crossKeys  = [makeKeypair(), makeKeypair(), makeKeypair(), makeKeypair()];
    });

    it('round-trips a chunked batch: matches + both capability sets rebuilt', async function () {
        let { v1, v2s } = buildBatch(0, [rawMatch('m1'), rawMatch('m2')], oracleKeys, crossKeys, { chunkSize: 300 });
        assert.ok(v2s.length >= 1, 'batch should actually chunk');
        let db = memDb([v1], v2s);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 1);
        assert.strictEqual(report.failed.length, 0);
        assert.strictEqual(db.matches.length, 2);
        assert.ok(db.matches.every(m => m.status === 'finalized'));
        assert.strictEqual(db.snapshots.filter(s => s.capability === 'cross_chain').length, 4);
        assert.strictEqual(db.snapshots.filter(s => s.capability === 'oracle_publish').length, 4);
    });

    it('latest-status-wins: a later batch retracts an earlier finalized match', async function () {
        let b0 = buildBatch(0, [rawMatch('m1', 'finalized')], oracleKeys, crossKeys);
        let b1 = buildBatch(1, [rawMatch('m1', 'retracted')], oracleKeys, crossKeys);
        let db = memDb([b0.v1, b1.v1], []);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 2);
        assert.strictEqual(db.matches.length, 1);
        assert.strictEqual(db.matches[0].status, 'retracted');
    });

    it('rejects a corrupted CRC and an incomplete chunk set', async function () {
        let bad   = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, { corruptCrc: true });
        let multi = buildBatch(1, [rawMatch('m2')], oracleKeys, crossKeys, { chunkSize: 200 });
        let db = memDb([bad.v1, multi.v1], multi.v2s.slice(0, multi.v2s.length - 1));   // drop the last chunk
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 0);
        assert.strictEqual(report.failed.length, 2);
        assert.ok(report.failed[0].reason.includes('BATCH_CRC32'));
        assert.ok(report.failed[1].reason.includes('incomplete batch'));
        assert.strictEqual(db.matches.length, 0);
    });

    it('rejects a sub-quorum wrapper and sub-quorum match signatures', async function () {
        let weakWrapper = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys, { wrapperSigners: 2 });   // 2 < 2f+1 = 3
        let weakMatch   = buildBatch(1, [rawMatch('m2')], oracleKeys, crossKeys, { matchSigners: 2 });
        let db = memDb([weakWrapper.v1, weakMatch.v1], []);
        let report = await new AnchorRecovery(db, quiet).run();

        assert.strictEqual(report.verified, 0);
        assert.ok(report.failed[0].reason.includes('wrapper signatures fail quorum'));
        assert.ok(report.failed[1].reason.includes('fails quorum against the archived cross_chain set'));
    });

    it('--verify-stakes kills a fabricated validator set with no on-chain stakes', async function () {
        let { v1 } = buildBatch(0, [rawMatch('m1')], oracleKeys, crossKeys);
        // All keys staked → passes. One cross_chain key unstaked → batch rejected.
        let allStaked = oracleKeys.concat(crossKeys).map(k => k.pubkey);
        let okReport = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb: btcDbStub(allStaked) }, quiet)).run();
        assert.strictEqual(okReport.verified, 1);

        let partial = allStaked.filter(p => p !== crossKeys[0].pubkey);
        let badReport = await new AnchorRecovery(memDb([v1], []), Object.assign({ btcDb: btcDbStub(partial) }, quiet)).run();
        assert.strictEqual(badReport.verified, 0);
        assert.ok(badReport.failed[0].reason.includes('no on-chain stake'));
    });
});

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The keys, wire builders and mock ANCHOR handler the ANCHOR suite shares
// (anchor.test.js plus the files in anchor.test/). armAnchor is what every
// block's beforeEach runs and disarmAnchor what its afterEach runs.

const sinon = require('sinon');
const zlib = require('zlib');
const { createMockIndexer } = require('../../../../../fixtures/mocks');
const Anchor = require('../../../../../../src/actions/anchor/index.js');
// Same module instance Anchor holds a reference to (Node module cache); stubbing
// `verify` here controls signature acceptance inside the handler.
const ed25519 = require('../../../../../../src/consensus/ed25519.js');
const swq = require('../../../../../../src/stake_weighted_quorum.js');
const arMod = require('../../../../../../src/anchor_reward_activation.js');

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const PUBKEY_C = 'c'.repeat(64);
const PUBKEY_D = 'd'.repeat(64);
const SIG      = '1'.repeat(128);

const HASH = (c) => c.repeat(64);

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
function gz64(str) { return zlib.gzipSync(Buffer.from(str, 'utf8'), { level: 9 }).toString('base64url'); }

// ANCHOR v0 params (the per-network checkpoint bundle; params[0] = VERSION, mirroring how
// actions/index.js splits the wire string): header, SECTION_COUNT sections in wire order, then
// ONE publisher tail for the whole bundle. `section_count` overrides the declared count
// independently of the sections actually emitted, so a lying header can be exercised.
function v0Params(overrides = {}) {
    let f = Object.assign({
        network: 'regtest', snapshot: '100',
        sections: [{ chain: 'BTC' }],
        publisher: PUBKEY_A, attest: [[PUBKEY_A, SIG]],
        section_count: null
    }, overrides);
    let sections = f.sections.map(s => Object.assign({
        chain: 'BTC', block_index: '500', block_hash: HASH('0'),
        ledger: HASH('1'), actions: HASH('2'), contracts: HASH('3'),
        seq: '0', snapshot: f.snapshot,
        state_root: HASH('d'), state_root_version: '1',
        block_merkle_root: HASH('e'), block_merkle_version: '1',
        sigs: [[PUBKEY_A, SIG]]
    }, s));
    let p = ['0', f.network, f.snapshot,
             String(f.section_count !== null ? f.section_count : sections.length)];
    for (let s of sections) {
        p.push(s.chain, s.block_index, s.block_hash, s.ledger, s.actions, s.contracts,
               s.seq, s.snapshot, s.state_root, s.state_root_version,
               s.block_merkle_root, s.block_merkle_version, String(s.sigs.length));
        for (let [pk, sg] of s.sigs) p.push(pk, sg);
    }
    p.push(f.publisher, String(f.attest.length));
    for (let [pk, sg] of f.attest) p.push(pk, sg);
    return p;
}

// A three-chain bundle in wire order (sections CHAIN ascending): the standard bundle shape.
const THREE_CHAINS = [{ chain: 'BTC',  block_index: '500' },
                      { chain: 'DOGE', block_index: '600' },
                      { chain: 'LTC',  block_index: '700' }];

// ANCHOR v1 params (the archive head): the checkpoint wrapper + archive segment +
// the wrapper sig list, then the
// PUBLISHER pubkey + the attestation sig list appended at the tail.
function v1Params(archiveJson, overrides = {}) {
    let b64 = (overrides.archive_b64 !== undefined) ? overrides.archive_b64 : gz64(archiveJson);
    let f = Object.assign({
        chain: 'BTC', network: 'regtest', block_index: '500', block_hash: HASH('0'),
        ledger: HASH('1'), actions: HASH('2'), contracts: HASH('3'),
        seq: '0', snapshot: '100',
        batch_seq: '0', match_count: '1',
        crc: crc32Hex(archiveJson), total_chunks: '1',
        sigs: [[PUBKEY_A, SIG]],
        publisher: PUBKEY_A, attest: [[PUBKEY_A, SIG]]
    }, overrides);
    let p = ['1', f.chain, f.network, f.block_index, f.block_hash, f.ledger, f.actions, f.contracts,
             f.seq, f.snapshot, f.batch_seq, f.match_count, f.crc, f.total_chunks, b64, String(f.sigs.length)];
    for (let [pk, sg] of f.sigs) p.push(pk, sg);
    p.push(f.publisher, String(f.attest.length));
    for (let [pk, sg] of f.attest) p.push(pk, sg);
    return p;
}

const ARCHIVE_JSON = JSON.stringify({ v: 1, network: 'regtest', batch_seq: 0, matches: [{ match_id: 'm1' }], capability_snapshots: [] });

// The archive head's AUTHOR address, i.e. what db.getAnchorV1ByBatchSeq now
// returns as `source`. Deliberately createBaseData's SOURCE: a v2 continuation chunk is
// authenticated by matching it, so every legitimate-chunk fixture below publishes as this
// address and the hostile ones publish as OUTSIDER.
const PUBLISHER = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const OUTSIDER  = 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef';

function addAnchorDbStubs(db) {
    db.getValidatorsByCapability  = sinon.stub().resolves([{ pubkey: PUBKEY_A, amount: '1' }]);
    db.hasCapability              = sinon.stub().resolves(true);
    db.getMaxAnchorCheckpointSeq  = sinon.stub().resolves(null);
    db.getArchiveReplayWatermarks = sinon.stub().resolves({ batchSeq: null, checkpointSeq: null });
    db.createAnchorAction         = sinon.stub().resolves();
    db.getAnchorV1ByBatchSeq      = sinon.stub().resolves(null);
    db.getAnchorChunks            = sinon.stub().resolves([]);
    db.setAnchorArchiveStatus     = sinon.stub().resolves();
    db.createValidatorReward      = sinon.stub().resolves(true);
    db.reconcileAnchorRewardWinner= sinon.stub().resolves(0);
}

// A fresh mock indexer and ANCHOR handler with the signature, quorum and
// derive-gate stubs every case starts from.
function armAnchor() {
    let indexer, handler, verifyStub, swqStub, deriveGateStub;
    indexer = createMockIndexer();
    indexer.config = Object.assign({}, indexer.config, { COIN: 'DOGE', NETWORK: 'regtest' });
    addAnchorDbStubs(indexer.indexerDb);
    handler = new Anchor(indexer);
    verifyStub = sinon.stub(ed25519, 'verify').returns(true);
    // These cases assert legacy COUNT quorum (the live mainnet path, whose
    // activation is a far-future placeholder). Regtest has stake-weighted
    // quorum active at every block, so pin the legacy path: the oracle_publish
    // mocks here carry no source/weight. Weighted coverage: stake_weighted_quorum.test.js.
    swqStub = sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
    // these cases assert the LEGACY DOGE-side reward derivation (still the
    // behavior below the derive-relocation flag-day / on mainnet, where the gate is an
    // inert placeholder). Pin the derive gate OFF so anchor.js runs the DOGE-side write;
    // the at/above-gate skip + BTC-side relocation are covered by anchor_reward_derive.test.js
    // and the dedicated 'derive-relocation flag-day' describe below.
    deriveGateStub = sinon.stub(arMod, 'isAnchorRewardDeriveActive').returns(false);
    return { indexer, handler, verifyStub, swqStub, deriveGateStub };
}

// sinon.restore() as well as the named ones: every beforeEach mints a fresh mock
// indexer (~210 fakes) into the default sandbox, and without draining it the suite
// trips sinon's 10000-fake leak warning partway through the file.
function disarmAnchor({ verifyStub, swqStub, deriveGateStub }) {
    verifyStub.restore(); swqStub.restore(); deriveGateStub.restore();
    sinon.restore();
}

module.exports = { PUBKEY_A, PUBKEY_B, PUBKEY_C, PUBKEY_D, SIG, HASH, crc32Hex, gz64, v0Params, THREE_CHAINS, v1Params, ARCHIVE_JSON, PUBLISHER, OUTSIDER, armAnchor, disarmAnchor };

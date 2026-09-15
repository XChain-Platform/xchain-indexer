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
// The keys, proofs and mock harness the whole SLASH suite runs on. The suite
// is slash.test.js plus the files in slash.test/; each file keeps its own
// names for the indexer, ctx, handler and offender and fills them through
// useSlashHarness, so the test bodies read exactly as they did when the suite
// was one file.

const sinon  = require('sinon');
const crypto = require('crypto');
const { createMockIndexer, createBaseData } = require('../../../../../fixtures/mocks');
const eq    = require('../../../../../../src/equivocation_header.js');
const srb   = require('../../../../../../src/snapshot_reorg_buffer.js');
const Slash = require('../../../../../../src/actions/slash/index.js');

// The height the verifier must RESOLVE a proof's set at, given the RAW height the proof
// declares. A proof carries the raw height because that is what the hub put on the wire;
// the hub resolved its own signer set at the buried one (CapabilitySnapshot subtracts
// CANONICAL_REORG_BUFFER), so a verifier reading the raw height selects a different set
// than the signer whenever stake moved inside (declared - 6, declared]. Derived here
// rather than hard-coded so these expectations track the shared constant.
const buried = (h) => srb.buriedSnapshotBlock(h, 'regtest');

// ── Ed25519 helpers matching src/consensus/ed25519.js (raw 32-byte pubkey hex, 64-byte sig hex) ──
function genKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const der = publicKey.export({ format: 'der', type: 'spki' });   // 12-byte SPKI prefix + 32-byte raw
    return { privateKey, pubHex: Buffer.from(der.slice(-32)).toString('hex') };
}
function sign(privateKey, msg) {
    return crypto.sign(null, Buffer.from(msg, 'utf8'), privateKey).toString('hex');
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');

// A realistic XMATCH (DEX) raw canonical; snapshot_block is field index 2.
function dexContent(snap, aAmount) {
    return ['XMATCH', 'm_42', String(snap),
            'BTC', '1', 'TICKA', String(aAmount), '0', 'addrA',
            'LTC', '2', 'TICKB', '5', '0', 'addrB',
            '1700000000', 'regtest', 'swap', '0', 'swap', '0'].join('|');
}

// The suite's hooks, installed in the calling describe: a fresh mock indexer, a
// fresh offender key and a handler over a DB stubbed as a clean, slashable
// offender before every test, handed to `bind`.
function useSlashHarness(bind) {
    let indexer, ctx, handler, offender;

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.config.GAS = 'XCHAIN';
        offender = genKey();

        // Stub the DB surface the verifier touches (default = a clean, slashable offender).
        const db = indexer.indexerDb;
        db.getValidatorsByCapability = sinon.stub().resolves([{ pubkey: offender.pubHex, amount: '1000' }]);
        db.getActiveValidators       = sinon.stub().resolves([{ pubkey: offender.pubHex, amount: '1000' }]);  // whole-federation set (XCONFIG membership)
        db.getOrCreatePubkeyId       = sinon.stub().resolves(7);
        db.hasCapabilitySlashEvent   = sinon.stub().resolves(false);
        // { total, releases }: the burn reports WHOSE escrow it reduced, because the handler
        // has to release the bond out of the staker's escrow before redirecting any of it.
        db.slashCapabilityStake      = sinon.stub().resolves({ total: '1000', releases: [{ address: 'staker1', amount: '1000' }] });
        // The handler resolves a delegated offender to its owning stake source at
        // the equivocation height before burning. Default to null (offender stakes in its
        // own name); the delegated-offender case overrides this per-test.
        db.getStakeSourceForDelegatedPubkey = sinon.stub().resolves(null);
        db.createCapabilitySlashEvent = sinon.stub().resolves();
        db.getAddressId              = sinon.stub().resolves(1);
        db.getAttestationAdmissionCounts = sinon.stub().resolves({ total: 0, byContract: 0 });
        db.getAttestationRequestById = sinon.stub().resolves(null);
        db.updateBalances            = sinon.stub().resolves();
        db.updateTokens              = sinon.stub().resolves();

        ctx = {
            config: indexer.config, util: indexer.util, mapper: indexer.mapper,
            decoderDb: indexer.decoderDb, indexerDb: db,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
        };
        handler = new Slash(ctx);
        indexer.util.resetLists();
        bind({ indexer, ctx, handler, offender });
    });
}

// Build SLASH params from two (msg, sig) pairs. The EQUIV key is NOT a wire field;
// it's derived from MSG_A's header and is not passed here.
function params(capability, offenderPubHex, msgA, privA, msgB, privB) {
    return ['0', capability, offenderPubHex,
            b64(msgA), sign(privA, msgA), b64(msgB), sign(privB, msgB)];
}
function data(extra) {
    return createBaseData(Object.assign({ ACTION: 'SLASH', FORMAT: 0, COIN: 'BTC', BLOCK_INDEX: 200, ACTION_INDEX: 999 }, extra));
}

// A genuine DEX equivocation: same (engine, round, view), different content, both
// signed by the offender.
function dexProof(snapA = 100, snapB = 100, viewA = 0, keyView = 0) {
    const key  = eq.equivKey(eq.ENGINE_TAGS.DEX, 'm_42', keyView);
    const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, 'm_42', viewA, dexContent(snapA, '10'));
    const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, 'm_42', viewA, dexContent(snapB, '20'));
    return { key, msgA, msgB };
}

// Two XCONFIG messages for one (seq, view) slot over the same snapshot_block
// with different config digests: a whole-federation equivocation.
function configProof(blk = 150, seq = '5', view = 0) {
    const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, seq, view, blk + '|digestA');
    const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, seq, view, blk + '|digestB');
    return { msgA, msgB };
}

module.exports = {
    buried, genKey, sign, b64, dexContent, params, data, dexProof, configProof, useSlashHarness,
};

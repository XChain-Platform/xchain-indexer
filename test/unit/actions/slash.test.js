// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.
//
// SLASH action handler — the deterministic equivocation verifier (WI-2 bump 2,
// Phase C). Exercises the consensus-critical accept/reject decision with REAL
// Ed25519 signatures and a stubbed DB (no mariadb → runs on any Node). The burn
// itself (slashCapabilityStake) is unit-tested separately; here we assert the
// verifier only fires on a genuine equivocation and rejects every near-miss.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const crypto = require('crypto');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const eq    = require('../../../src/equivocation_header.js');
const Slash = require('../../../src/actions/slash.js');

// ── Ed25519 helpers matching src/ed25519.js (raw 32-byte pubkey hex, 64-byte sig hex) ──
function genKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const der = publicKey.export({ format: 'der', type: 'spki' });   // 12-byte SPKI prefix + 32-byte raw
    return { privateKey, pubHex: Buffer.from(der.slice(-32)).toString('hex') };
}
function sign(privateKey, msg) {
    return crypto.sign(null, Buffer.from(msg, 'utf8'), privateKey).toString('hex');
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');

// A realistic XMATCH (DEX) raw canonical — snapshot_block is field index 2.
function dexContent(snap, aAmount) {
    return ['XMATCH', 'm_42', String(snap),
            'BTC', '1', 'TICKA', String(aAmount), '0', 'addrA',
            'LTC', '2', 'TICKB', '5', '0', 'addrB',
            '1700000000', 'regtest', 'swap', '0', 'swap', '0'].join('|');
}

describe('SLASH action handler — equivocation verifier @regression', function () {
    let indexer, ctx, handler, offender;

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.config.GAS = 'XCHAIN';
        offender = genKey();

        // Stub the DB surface the verifier touches (default = a clean, slashable offender).
        const db = indexer.indexerDb;
        db.getValidatorsByCapability = sinon.stub().resolves([{ pubkey: offender.pubHex, amount: '1000' }]);
        db.getOrCreatePubkeyId       = sinon.stub().resolves(7);
        db.hasCapabilitySlashEvent   = sinon.stub().resolves(false);
        db.slashCapabilityStake      = sinon.stub().resolves('1000');
        db.createCapabilitySlashEvent = sinon.stub().resolves();
        db.getAddressId              = sinon.stub().resolves(1);
        db.getAttestationRequestById = sinon.stub().resolves(null);
        db.updateBalances            = sinon.stub().resolves();
        db.updateTokens              = sinon.stub().resolves();

        ctx = {
            config: indexer.config, util: indexer.util, mapper: indexer.mapper,
            decoderDb: indexer.decoderDb, indexerDb: db,
        };
        handler = new Slash(ctx);
        indexer.util.resetLists();
    });

    // Build SLASH params from two (msg, sig) pairs. The EQUIV key is NOT a wire field —
    // it's derived from MSG_A's header — so it is not passed here.
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

    it('ACCEPTS a genuine DEX equivocation and burns the bond', async function () {
        const { key, msgA, msgB } = dexProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex,msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce, 'slashCapabilityStake must be called once');
        assert.deepStrictEqual(indexer.indexerDb.slashCapabilityStake.firstCall.args, [7, 200, 999]);
        assert.ok(indexer.indexerDb.createCapabilitySlashEvent.calledOnce, 'an audit event must be written');
    });

    it('REJECTS an honest view change (R-3): same round, different view → different key', async function () {
        // Two legit signatures under views 0 and 1; the submitter can only name ONE key,
        // so the other message fails the shared-prefix check.
        const key  = eq.equivKey(eq.ENGINE_TAGS.DEX, 'm_42', 0);
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, 'm_42', 0, dexContent(100, '10'));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, 'm_42', 1, dexContent(100, '20')); // view 1
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex,msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/EQUIV header\/key mismatch/.test(d['STATUS']), 'expected key-mismatch reject, got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS identical messages (PREPARE-then-COMMIT same bytes ≠ equivocation)', async function () {
        const key = eq.equivKey(eq.ENGINE_TAGS.DEX, 'm_42', 0);
        const msg = eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, 'm_42', 0, dexContent(100, '10'));
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex,msg, offender.privateKey, msg, offender.privateKey), d, null);

        assert.ok(/identical messages/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS a forged signature (sig does not verify against offender)', async function () {
        const { key, msgA, msgB } = dexProof();
        const other = genKey();   // sign msgB with a DIFFERENT key
        const p = ['0', 'cross_chain', offender.pubHex,
                   b64(msgA), sign(offender.privateKey, msgA), b64(msgB), sign(other.privateKey, msgB)];
        const d = data();
        await handler.parse(p, d, null);

        assert.ok(/SIG_B/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS when the offender is not in the capability snapshot at the slot', async function () {
        indexer.indexerDb.getValidatorsByCapability = sinon.stub().resolves([]);   // empty set
        const { key, msgA, msgB } = dexProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex,msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/not in capability snapshot/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS a replay once already slashed (idempotent)', async function () {
        indexer.indexerDb.hasCapabilitySlashEvent = sinon.stub().resolves(true);
        const { key, msgA, msgB } = dexProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex,msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/already slashed/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS XCONFIG (not slashable — no recoverable snapshot_block)', async function () {
        const key  = eq.equivKey(eq.ENGINE_TAGS.CONFIG, '5', 0);
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, '5', 0, 'digestA');
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, '5', 0, 'digestB');
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex,msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/ENGINE_TAG \(not slashable\)/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS a CAPABILITY that does not match the engine', async function () {
        const { key, msgA, msgB } = dexProof();   // XDEX → cross_chain
        const d = data();
        await handler.parse(params('price', offender.pubHex,msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/CAPABILITY \(does not match engine\)/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS when the two messages disagree on snapshot_block', async function () {
        const { key, msgA, msgB } = dexProof(100, 101);   // different snapshot_block in content
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex,msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/snapshot_block/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('ACCEPTS an XORACLE equivocation (snapshot_block recovered from ROUND_ID)', async function () {
        const round = '150';   // the round id IS the BTC block
        const key   = eq.equivKey(eq.ENGINE_TAGS.ORACLE, round, 0);
        const msgA  = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, round, 0, '{"BTCUSD":"60000"}');
        const msgB  = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, round, 0, '{"BTCUSD":"61000"}');
        const d = data();
        await handler.parse(params('price', offender.pubHex,msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        // membership was checked at the round's block
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['price', 150]);
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce);
    });

    // ── Bounty / treasury split (Phase D mechanism; governance config + BURN default) ──
    describe('_bountyTreasurySplit', function () {
        function withSlashConfig(cfg) {
            indexer.config.STAKING = { CAPABILITIES: { cross_chain: { MIN_STAKE: '5000', SLASH: cfg } } };
        }

        it('pure burn when no SLASH config (bounty 0, no treasury credit)', function () {
            const s = handler._bountyTreasurySplit('cross_chain', '1000');
            assert.strictEqual(Number(s.bounty), 0);
            assert.strictEqual(s.treasuryAddr, null);          // null = BURN
            assert.strictEqual(Number(s.treasury), 1000);      // the whole bond leaves circulation
        });

        it('applies BOUNTY_BPS and routes the remainder to the treasury', function () {
            withSlashConfig({ BOUNTY_BPS: 500, TREASURY_ADDRESS: 'addrT' });   // 5%
            const s = handler._bountyTreasurySplit('cross_chain', '1000');
            assert.strictEqual(Number(s.bounty), 50);
            assert.strictEqual(Number(s.treasury), 950);
            assert.strictEqual(s.treasuryAddr, 'addrT');
            // Conservation: bounty + treasury == burned (never mints, never loses).
            assert.strictEqual(Number(indexer.util.bcadd(s.bounty, s.treasury, 8)), 1000);
            assert.strictEqual(typeof s.bounty, 'string');   // ledger sees plain strings, not BigNumbers
        });

        it('clamps the bounty to BOUNTY_CAP', function () {
            withSlashConfig({ BOUNTY_BPS: 5000, BOUNTY_CAP: '10', TREASURY_ADDRESS: 'addrT' });   // 50% capped at 10
            const s = handler._bountyTreasurySplit('cross_chain', '1000');
            assert.strictEqual(Number(s.bounty), 10);
            assert.strictEqual(Number(s.treasury), 990);
        });

        it('clamps BOUNTY_BPS to 100% (never pays more than the bond)', function () {
            withSlashConfig({ BOUNTY_BPS: 99999, TREASURY_ADDRESS: 'addrT' });
            const s = handler._bountyTreasurySplit('cross_chain', '1000');
            assert.strictEqual(Number(s.bounty), 1000);
            assert.strictEqual(Number(s.treasury), 0);
        });

        it('a zero burn splits to all-zero with no treasury credit', function () {
            withSlashConfig({ BOUNTY_BPS: 500, TREASURY_ADDRESS: 'addrT' });
            const s = handler._bountyTreasurySplit('cross_chain', '0');
            assert.strictEqual(Number(s.bounty), 0);
            assert.strictEqual(Number(s.treasury), 0);
            assert.strictEqual(s.treasuryAddr, null);
        });
    });
});

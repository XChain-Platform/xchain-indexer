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
// SLASH action handler: the deterministic equivocation verifier (WI-2 bump 2,
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

// A realistic XMATCH (DEX) raw canonical; snapshot_block is field index 2.
function dexContent(snap, aAmount) {
    return ['XMATCH', 'm_42', String(snap),
            'BTC', '1', 'TICKA', String(aAmount), '0', 'addrA',
            'LTC', '2', 'TICKB', '5', '0', 'addrB',
            '1700000000', 'regtest', 'swap', '0', 'swap', '0'].join('|');
}

describe('SLASH action handler: equivocation verifier @regression', function () {
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
        // #3163: the handler resolves a delegated offender to its owning stake source at
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
    });

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

    it('ACCEPTS a genuine DEX equivocation and burns the bond', async function () {
        const { key, msgA, msgB } = dexProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex,msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce, 'slashCapabilityStake must be called once');
        // 4th arg is burnPending (SLASH-1): true here since the mock flag defaults on.
        // 5th is ownerSourceId (#3163): null because this offender stakes in its own name.
        assert.deepStrictEqual(indexer.indexerDb.slashCapabilityStake.firstCall.args, [7, 200, 999, true, null]);
        assert.ok(indexer.indexerDb.createCapabilitySlashEvent.calledOnce, 'an audit event must be written');
    });

    // A bond is LOCKED in the staker's escrow, so a slash REDIRECTS tokens rather than
    // minting them. These assert the whole ledger effect of one slash, not that a call was
    // made: supply delta = credits - debits + escrows.
    function ledgerOf(applied){
        const [, , credits, debits, escrows] = applied.firstCall.args;
        const sum = rows => (rows || []).reduce((a, r) => a + Number(r[1]), 0);
        return { credits, debits, escrows, sum,
                 delta: sum(credits) - sum(debits) + sum(escrows) };
    }

    it('releases the burned bond from the STAKERS escrow, per owner, not from the submitter', async function () {
        indexer.config.STAKING = { CAPABILITIES: { cross_chain: { MIN_STAKE: '5000',
            SLASH: { BOUNTY_BPS: 500 } } } };                       // 5% bounty, remainder BURNED
        indexer.indexerDb.slashCapabilityStake = sinon.stub().resolves({
            total: '1000',
            releases: [{ address: 'stakerA', amount: '600' }, { address: 'stakerB', amount: '400' }]
        });
        const applied = sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();

        const { msgA, msgB } = dexProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        const L = ledgerOf(applied);
        // The release is keyed to whoever HOLDS the lock. A delegated key's bond lives on the
        // owning source, so this is not data['SOURCE'] and cannot be assumed to be one address.
        assert.deepStrictEqual(L.escrows.map(r => r[2]).sort(), ['stakerA', 'stakerB']);
        assert.strictEqual(L.sum(L.escrows), -1000, 'the whole bond must come out of escrow');
        assert.strictEqual(L.sum(L.credits), 50,    'only the 5% bounty re-enters circulation');
        // 950 was redirected to a treasury with no address, i.e. genuinely burned. Supply
        // falls by exactly that, and by nothing else.
        assert.strictEqual(L.delta, -950,
            'supply must fall by the UNREDIRECTED remainder - no more (a mint) and no less (a strand)');
    });

    it('a fully redirected slash moves no supply at all', async function () {
        indexer.config.STAKING = { CAPABILITIES: { cross_chain: { MIN_STAKE: '5000',
            SLASH: { BOUNTY_BPS: 500, TREASURY_ADDRESS: 'addrT' } } } };
        indexer.indexerDb.slashCapabilityStake = sinon.stub().resolves({
            total: '1000', releases: [{ address: 'stakerA', amount: '1000' }]
        });
        const applied = sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();

        const { msgA, msgB } = dexProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        const L = ledgerOf(applied);
        assert.strictEqual(L.sum(L.credits), 1000, 'bounty + treasury account for the whole bond');
        assert.strictEqual(L.sum(L.escrows), -1000);
        assert.strictEqual(L.delta, 0, 'nothing was destroyed, so supply must not move');
    });

    it('a zero burn writes no escrow release', async function () {
        indexer.indexerDb.slashCapabilityStake = sinon.stub().resolves({ total: '0', releases: [] });
        const applied = sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();

        const { msgA, msgB } = dexProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid', 'an emptied bond still records a valid slash');
        const L = ledgerOf(applied);
        assert.strictEqual(L.escrows.length, 0);
        assert.strictEqual(L.delta, 0);
    });

    // A delegated signing key owns no stake, so burning by its own pubkey
    // matched nothing: the slash recorded as valid and burned ZERO. The handler must
    // resolve the owning source AT THE EQUIVOCATION HEIGHT and burn there.
    it('a DELEGATED offender burns the owning source\'s bond, resolved at the equivocation height', async function () {
        indexer.indexerDb.getStakeSourceForDelegatedPubkey = sinon.stub().resolves(42);
        const { msgA, msgB } = dexProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        const resolve = indexer.indexerDb.getStakeSourceForDelegatedPubkey.firstCall;
        assert.ok(resolve, 'the handler must attempt a delegated-owner resolution');
        assert.strictEqual(resolve.args[0], 7, 'resolved for the offending pubkey id');
        // 100 is the proof's snapshot_block (dexContent snapA); 200 is BLOCK_INDEX, the
        // processing height. They differ here on purpose: that gap is the whole point of
        // the pinned resolution. Revoking the delegation between 100 and 200 must not
        // orphan the proof, so the resolution must read 100.
        assert.strictEqual(resolve.args[1], 100,
            'must resolve at the EQUIVOCATION height (proof snapshot_block), not the processing height');
        assert.strictEqual(indexer.indexerDb.slashCapabilityStake.firstCall.args[4], 42,
            'the burn must target the owning stake source');
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

    // Config content = `snapshot_block|config_digest`; equivocation = same (seq, view),
    // same snapshot_block, DIFFERENT digest. Membership resolves against getActiveValidators
    // (the whole federation), labelled with the sentinel capability 'config'.
    function configProof(blk = 150, seq = '5', view = 0) {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, seq, view, blk + '|digestA');
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, seq, view, blk + '|digestB');
        return { msgA, msgB };
    }

    it('ACCEPTS an XCONFIG equivocation (snapshot_block recovered from content; federation membership)', async function () {
        const { msgA, msgB } = configProof(150);
        const d = data();
        await handler.parse(params('config', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid', 'got ' + d['STATUS']);
        // membership checked against the WHOLE federation at the in-content snapshot_block
        assert.deepStrictEqual(indexer.indexerDb.getActiveValidators.firstCall.args, [150]);
        assert.ok(indexer.indexerDb.getValidatorsByCapability.notCalled, 'config must NOT use a capability set');
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce);
        // audit row keyed by the sentinel 'config' capability
        assert.strictEqual(indexer.indexerDb.createCapabilitySlashEvent.firstCall.args[0]['CAPABILITY'], 'config');
    });

    it('REJECTS XCONFIG when the offender is not in the federation snapshot', async function () {
        indexer.indexerDb.getActiveValidators = sinon.stub().resolves([]);   // empty federation set
        const { msgA, msgB } = configProof(150);
        const d = data();
        await handler.parse(params('config', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/not in federation snapshot/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS XCONFIG when the two messages disagree on snapshot_block', async function () {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, '5', 0, '150|digestA');
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CONFIG, '5', 0, '151|digestA');   // different block
        const d = data();
        await handler.parse(params('config', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/snapshot_block/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS XCONFIG with a non-config CAPABILITY label (derived, not trusted)', async function () {
        const { msgA, msgB } = configProof(150);
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/CAPABILITY \(does not match engine\)/.test(d['STATUS']), 'got ' + d['STATUS']);
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

    // ── XORACLE round discrimination (, gated SLASH_ORACLE_ROUND_DISCRIMINATED) ──
    //
    // The EQUIV key for XORACLE is `XORACLE|<btc_height>|0` (ed25519.buildPriceV0Payload),
    // but oracle rounds advance on wall-clock while the captured BTC tip can stand still,
    // so an honest validator's rounds N and N+1 share that key and differ in content. That
    // pair used to reach STATUS=valid and burn the whole bond.
    function priceContent(round, btcHeight, price) {
        return JSON.stringify({
            round: round, timestamp: 1700000000, btc_block_height: btcHeight,
            pairs: [{ pair: 'BTCUSD', price: String(price) }]
        });
    }

    it('REJECTS an XORACLE pair whose signed contents declare DIFFERENT rounds', async function () {
        const height = '961123';
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, height, 0, priceContent(100, 961123, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, height, 0, priceContent(101, 961123, 61000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.notStrictEqual(d['STATUS'], 'valid');
        assert.ok(String(d['STATUS']).indexOf('ORACLE round mismatch') >= 0, 'got: ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled,
            'an honest validator signing two distinct rounds at one BTC tip must keep its bond');
    });

    it('still ACCEPTS a real same-round XORACLE double-sign', async function () {
        const height = '961123';
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, height, 0, priceContent(100, 961123, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, height, 0, priceContent(100, 961123, 61000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['price', 961123]);
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce, 'genuine equivocation must still burn');
    });

    it('REJECTS an XORACLE pair whose content height disagrees with the EQUIV ROUND_ID', async function () {
        const height = '961123';
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, height, 0, priceContent(100, 961123, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, height, 0, priceContent(100, 961999, 61000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.notStrictEqual(d['STATUS'], 'valid');
        assert.ok(String(d['STATUS']).indexOf('ORACLE btc_block_height') >= 0, 'got: ' + d['STATUS']);
    });

    it('below the flag-day the pre-fix behavior is byte-identical (distinct rounds still slash)', async function () {
        ctx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) =>
            name !== 'SLASH_ORACLE_ROUND_DISCRIMINATED');
        const height = '961123';
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, height, 0, priceContent(100, 961123, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, height, 0, priceContent(101, 961123, 61000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid', 'the gate must leave sub-flag-day acceptance untouched');
    });

    // ── XORACLEB: PRICE batch canonicals ──
    //
    // A batch canonical declares first_round/last_round and NO scalar `round`, which is the
    // exact shape the XORACLE leg's invariant ("a content with no `round` cannot have come
    // from buildPriceV0Payload") does not cover: under a shared tag its distinct-rounds
    // guard would skip, and an honest validator that signed one v0 round and one batch
    // at the same BTC anchor would read as a provable equivocator, for a full bond burn
    // plus permanent capability disqualification. The distinct tag plus the composite
    // ROUND_ID `<anchor>|<first_round>|<last_round>` is what keeps that from happening.

    // buildPriceBatchPayload's emitted JSON (key order as the builder emits it).
    function batchContent(first, last, btcHeight, price) {
        return JSON.stringify({
            first_round: first, last_round: last, btc_block_height: btcHeight,
            rounds: [{ round: first, timestamp: 1700000000, btc_block_height: btcHeight,
                       pairs: [{ pair: 'BTCUSD', price: String(price) }] }]
        });
    }
    const batchRoundId = (anchor, first, last) => [anchor, first, last].join('|');

    it('ACCEPTS a genuine XORACLEB equivocation (two batches over ONE window at one anchor)', async function () {
        const anchor = 961123;
        const rid = batchRoundId(anchor, 100, 105);
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 105, anchor, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 105, anchor, 61000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid', 'got ' + d['STATUS']);
        // The capability map must route XORACLEB to `price`, and the snapshot block must be
        // the FIRST segment of the composite round id, not the whole id.
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['price', anchor]);
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce, 'a real double-signed batch must burn');
    });

    it('REJECTS an honest v0 round paired with an honest batch at ONE anchor', async function () {
        // The defect this row exists to prevent: under a shared engine tag these two share
        // the equiv key, differ in content, and burn a full bond off two honest signatures.
        const anchor = 961123;
        const v0 = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, String(anchor), 0, priceContent(100, anchor, 60000));
        const v2 = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, batchRoundId(anchor, 100, 105), 0,
                                          batchContent(100, 105, anchor, 60000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, v0, offender.privateKey, v2, offender.privateKey), d, null);

        assert.notStrictEqual(d['STATUS'], 'valid', 'an honest v0 round and an honest batch are not one slot');
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled,
            'a validator that signed one honest round and one honest batch must keep its bond');
    });

    it('REJECTS two honest batches that split ONE window differently at one anchor', async function () {
        // Two leaders may legitimately cut the same window at different points, so the
        // window is in the round id and the two batches never collide on one key.
        const anchor = 961123;
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, batchRoundId(anchor, 100, 105), 0,
                                            batchContent(100, 105, anchor, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, batchRoundId(anchor, 100, 102), 0,
                                            batchContent(100, 102, anchor, 60000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.notStrictEqual(d['STATUS'], 'valid', 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled,
            'two honest sub-ranges at one anchor must keep the bond');
    });

    it('REJECTS a batch pair sharing one key whose contents declare DIFFERENT windows', async function () {
        // The in-content leg of the same defence: contents that end at different rounds are
        // two messages, not two versions of one, whatever the shared header says.
        const anchor = 961123;
        const rid = batchRoundId(anchor, 100, 105);
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 105, anchor, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 102, anchor, 60000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.notStrictEqual(d['STATUS'], 'valid', 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled,
            'a window that differs only at its LAST round is still a distinct window');
    });

    it('REJECTS a batch pair whose content anchor disagrees with the ROUND_ID anchor', async function () {
        const anchor = 961123;
        const rid = batchRoundId(anchor, 100, 105);
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 105, anchor, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 105, 961999, 61000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(String(d['STATUS']).indexOf('ORACLE_BATCH btc_block_height') >= 0, 'got: ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS an XORACLEB round id that is not <anchor>|<first>|<last>', async function () {
        // The membership snapshot is read off segment 0, so a round id of another shape
        // must never resolve to a block at all.
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, '961123|100', 0, batchContent(100, 105, 961123, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, '961123|100', 0, batchContent(100, 105, 961123, 61000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(String(d['STATUS']).indexOf('ORACLE_BATCH round id') >= 0, 'got: ' + d['STATUS']);
        assert.ok(indexer.indexerDb.getValidatorsByCapability.notCalled);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS an XORACLEB round id whose window runs backwards', async function () {
        const rid = batchRoundId(961123, 105, 100);
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(105, 100, 961123, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(105, 100, 961123, 61000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(String(d['STATUS']).indexOf('ORACLE_BATCH window') >= 0, 'got: ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS an XORACLEB proof labelled with a capability other than price', async function () {
        const rid = batchRoundId(961123, 100, 105);
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 105, 961123, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 105, 961123, 61000));
        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/CAPABILITY \(does not match engine\)/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('the XORACLEB discrimination is NOT gated on SLASH_ORACLE_ROUND_DISCRIMINATED', async function () {
        // A new tag has no pre-fix verdicts to reproduce, so there must be no height window
        // in which two honest splits burn a bond.
        ctx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) =>
            name !== 'SLASH_ORACLE_ROUND_DISCRIMINATED');
        const anchor = 961123;
        const rid = batchRoundId(anchor, 100, 105);
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 105, anchor, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 102, anchor, 60000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.notStrictEqual(d['STATUS'], 'valid', 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    // ── CHECKPOINT engine tag: two content families ──
    // XCHECKPOINT (root canonical, snapshot_block at index 9) and XANCPUB (reward
    // attestation, snapshot_block at index 3) share the CHECKPOINT engine tag.

    // Realistic XCHECKPOINT raw canonical, in the root-bearing shape an ANCHOR v7 section
    // carries; snapshot_block is field index 9, ahead of the root suffix.
    function checkpointContent(snap, ledgerHash) {
        return ['XCHECKPOINT', 'BTC', 'regtest', '199', 'aa'.repeat(32), ledgerHash,
                'cc'.repeat(32), 'dd'.repeat(32), '5', String(snap),
                'ee'.repeat(32), '1', 'ff'.repeat(32), '1'].join('|');
    }
    // XANCPUB reward-attestation canonical (per-chain leg); snapshot_block is field index 3.
    function ancpubContent(snap, publisher) {
        return ['XANCPUB', 'anchor_BTC', '5', String(snap), publisher, '50'].join('|');
    }
    const CP_ROUND = 'cp_5';

    it('ACCEPTS an XCHECKPOINT equivocation (snapshot_block at index 9)', async function () {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, CP_ROUND, 0, checkpointContent(100, 'e1'.repeat(32)));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, CP_ROUND, 0, checkpointContent(100, 'e2'.repeat(32)));
        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['oracle_publish', 100]);
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce);
    });

    it('ACCEPTS an XANCPUB equivocation (snapshot_block at index 3)', async function () {
        // Same round, two different attested publishers = a reward-attestation double-sign.
        const round = 'XANCPUB|BTC|regtest|5|100';
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, round, 0, ancpubContent(100, 'aaaa'.repeat(16)));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, round, 0, ancpubContent(100, 'bbbb'.repeat(16)));
        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['oracle_publish', 100]);
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce);
    });

    it('ACCEPTS an archive-leg XANCPUB equivocation (anchor_archive scope)', async function () {
        const round = 'XANCPUB|archive|regtest|7|100';
        const base  = (pub) => ['XANCPUB', 'anchor_archive', '7', '100', pub, '50'].join('|');
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, round, 0, base('aaaa'.repeat(16)));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, round, 0, base('bbbb'.repeat(16)));
        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['oracle_publish', 100]);
    });

    it('ACCEPTS a bundle-leg XANCPUB equivocation (anchor_bundle scope, ANCHOR v7)', async function () {
        // The bundle canonical repeats SNAPSHOT_BLOCK as its round_reference, keeping the
        // SIX positional fields (D22) so this branch finds the block at index 3 with no
        // third case in slash.js. Two attested publishers for one bundle round is a
        // reward-attestation double-sign exactly as on the per-chain and archive legs.
        const round = 'XANCPUB|bundle|regtest|100';
        const base  = (pub) => ['XANCPUB', 'anchor_bundle', '100', '100', pub, '50'].join('|');
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, round, 0, base('aaaa'.repeat(16)));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, round, 0, base('bbbb'.repeat(16)));
        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['oracle_publish', 100]);
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce);
    });

    it('REJECTS an XANCPUB pair that disagrees on snapshot_block', async function () {
        const round = 'XANCPUB|BTC|regtest|5|100';
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, round, 0, ancpubContent(100, 'aaaa'.repeat(16)));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, round, 0, ancpubContent(101, 'aaaa'.repeat(16)));
        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/snapshot_block/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS a mixed XCHECKPOINT/XANCPUB pair (content family mismatch)', async function () {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, CP_ROUND, 0, checkpointContent(100, 'e1'.repeat(32)));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.CHECKPOINT, CP_ROUND, 0, ancpubContent(100, 'aaaa'.repeat(16)));
        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/family mismatch/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    // ── the field indices come from a REAL builder, not from a hand-copied join ──
    //
    // _resolveSlot hard-codes the in-content snapshot_block position per engine
    // (CHECKPOINT 9, XANCPUB 3). slash.js is a SEVENTH consumer of the XCHECKPOINT
    // layout and sits on no lockstep list and in no cross-service parity suite; the
    // parity suites compare builders to builders, and every fixture above rebuilds
    // the layout by hand, so a coordinated field insertion between CHAIN|NETWORK and
    // SNAPSHOT_BLOCK keeps all of them green while _resolveSlot starts reading
    // CHECKPOINT_SEQ as the slot. That resolves the WRONG capability snapshot: real
    // proofs get rejected, or a bond burns against the wrong height. And because
    // deriveCheckpointSeq(snapshot_block) returns snapshot_block, an off-by-one-segment
    // read looks plausible on live data while being structurally wrong.
    //
    // These two cases source the signed bytes from the indexer's OWN builder
    // (Anchor._canonical / Anchor._rewardCanonical, the sibling of the hub's
    // StateCheckpointEngine.canonicalCheckpoint), so a layout change in anchor.js
    // moves the fixture and this file goes red rather than agreeing with itself.
    // Called off the prototype with a bare receiver: neither builder touches `this`.
    const Anchor = require('../../../src/actions/anchor.js');
    const CP_SNAP = 100;
    function builtCheckpoint(ledgerHash) {
        // FORMAT 7 = a bundle SECTION, the only checkpoint canonical the hub still signs.
        // The root suffix it appends sits AFTER segment 9, so the slot read is unmoved -
        // which is the point of pinning it against the real builder rather than a literal.
        return Anchor.prototype._canonical.call({}, {
            FORMAT: 7, CHAIN: 'BTC', NETWORK: 'regtest',
            BLOCK_INDEX_CHECKPOINTED: 199, BLOCK_HASH: 'aa'.repeat(32),
            LEDGER_HASH: ledgerHash, ACTIONS_HASH: 'cc'.repeat(32),
            CONTRACT_HASH: 'dd'.repeat(32), CHECKPOINT_SEQ: 5, SNAPSHOT_BLOCK: CP_SNAP,
            STATE_ROOT: 'ee'.repeat(32), STATE_ROOT_VERSION: 1,
            BLOCK_MERKLE_ROOT: 'ff'.repeat(32), BLOCK_MERKLE_VERSION: 1,
        });
    }
    function builtBundleAttestation(publisher) {
        return Anchor.prototype._rewardCanonical.call({}, {
            FORMAT: 7, NETWORK: 'regtest', SNAPSHOT_BLOCK: CP_SNAP, PUBLISHER: publisher,
        });
    }
    function builtArchiveAttestation(publisher) {
        return Anchor.prototype._rewardCanonical.call({}, {
            FORMAT: 6, CHAIN: 'BTC', NETWORK: 'regtest', MATCH_BATCH_SEQ: 7,
            SNAPSHOT_BLOCK: CP_SNAP, PUBLISHER: publisher, CHECKPOINT_SEQ: 5,
        });
    }
    const equivContent = (msg) => msg.slice(msg.indexOf('||') + 2);

    it('resolves the CHECKPOINT slot from a canonical the real builder produced', async function () {
        const msgA = builtCheckpoint('e1'.repeat(32));
        const msgB = builtCheckpoint('e2'.repeat(32));
        // Pin the positional read itself, so a shift reports as a layout change rather
        // than as an opaque wrong-slot number further down.
        assert.strictEqual(equivContent(msgA).split('|')[9], String(CP_SNAP),
            'Anchor._canonical no longer carries SNAPSHOT_BLOCK at segment 9; slash._resolveSlot ' +
            'FIELD[CHECKPOINT] still says 9 and would resolve the wrong bond slot. Content was: ' +
            equivContent(msgA));

        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args,
            ['oracle_publish', CP_SNAP],
            'the slot must be the builder-produced SNAPSHOT_BLOCK, not whatever sits at segment 9');
    });

    it('resolves the XANCPUB slot from a canonical the real builder produced', async function () {
        const msgA = builtArchiveAttestation('aaaa'.repeat(16));
        const msgB = builtArchiveAttestation('bbbb'.repeat(16));
        assert.strictEqual(equivContent(msgA).split('|')[3], String(CP_SNAP),
            'Anchor._rewardCanonical no longer carries SNAPSHOT_BLOCK at segment 3; slash._resolveSlot ' +
            'switches to index 3 on the XANCPUB family and would resolve the wrong bond slot. Content was: ' +
            equivContent(msgA));

        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args,
            ['oracle_publish', CP_SNAP]);
    });

    it('resolves the BUNDLE XANCPUB slot from a canonical the real builder produced', async function () {
        const msgA = builtBundleAttestation('aaaa'.repeat(16));
        const msgB = builtBundleAttestation('bbbb'.repeat(16));
        assert.strictEqual(equivContent(msgA).split('|')[3], String(CP_SNAP),
            'Anchor._rewardCanonical\'s v7 branch no longer carries SNAPSHOT_BLOCK at segment 3; ' +
            'slash._resolveSlot reads index 3 for every XANCPUB family and would resolve the wrong ' +
            'bond slot. Content was: ' + equivContent(msgA));
        assert.strictEqual(equivContent(msgA).split('|').length, 6,
            'the bundle canonical must keep SIX positional fields (D22): a five-field layout ' +
            'would make every bundle equivocation read as invalid: snapshot_block');

        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args,
            ['oracle_publish', CP_SNAP],
            'slash.js needs NO third branch for the bundle: index 3 already finds its snapshot_block');
    });

    it('the hand-written checkpoint fixture still matches the real builder segment for segment', function () {
        // The fixtures above stay hand-written on purpose (they vary fields the builder
        // would not), so bind their SHAPE to the builder here: same segment count, same
        // snapshot_block position. Without this, a field insertion updates the builder
        // and leaves every hand-written fixture generating the stale ten-segment string.
        const built = equivContent(builtCheckpoint('e1'.repeat(32))).split('|');
        const hand  = checkpointContent(CP_SNAP, 'e1'.repeat(32)).split('|');
        assert.strictEqual(hand.length, built.length,
            `hand-written checkpointContent() has ${hand.length} segments, the builder emits ` +
            `${built.length}; the fixture is a stale copy of the canonical layout`);
        assert.strictEqual(hand.indexOf(String(CP_SNAP)), built.indexOf(String(CP_SNAP)),
            'hand-written fixture puts snapshot_block at a different segment than the builder');
    });

    // XATTEST hosts TWO content families (Phase 5). The base v1 canonical is
    // delimiter-less and carries no block, so the slot resolver reads it from the mirrored
    // request row; the relay legs are XCALL-shaped (snapshot_block at index 3) under a
    // HASHED round id, and are quorum-verified against `cross_chain`, not `attestation`.
    // Before #3882 the resolver knew only the base family, so every relay double-sign was
    // unslashable: the hashed round id could never match a request_id.
    const RELAY_ROUND = 'f1'.repeat(32);   // sha256('ATTESTRELAY|request|req_1') shape
    function relayRequestContent(snap, providerId) {
        return ['ATTEST', 'RELAY_REQUEST', 'req_1', String(snap), 'regtest', 'LTC', '5',
                providerId, 'aa'.repeat(32), '3', '100'].join('|');
    }
    function relayResponseContent(snap, responseHash) {
        return ['ATTEST', 'RELAY_RESPONSE', 'req_1', String(snap), 'regtest', 'LTC', '5',
                'provider_x', responseHash, '1', ''].join('|');
    }
    // v1 base canonical: request_id + provider + response_hash + status + meta, no delimiters.
    function baseAttestContent(responseHash) {
        return 'req_1' + 'provider_x' + responseHash + '1';
    }

    it('ACCEPTS a relay REQUEST double-sign and slashes the cross_chain bond', async function () {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayRequestContent(100, 'provider_x'));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayRequestContent(100, 'provider_y'));
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['cross_chain', 100],
            'relay legs are locked under cross_chain, the set _verifyRelayQuorum verifies against');
        assert.ok(indexer.indexerDb.getAttestationRequestById.notCalled,
            'a hashed relay ROUND_ID is never a request_id lookup');
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce);
    });

    it('ACCEPTS a relay RESPONSE double-sign', async function () {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayResponseContent(100, 'e1'.repeat(32)));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayResponseContent(100, 'e2'.repeat(32)));
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['cross_chain', 100]);
    });

    it('REJECTS a relay pair that disagrees on snapshot_block', async function () {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayRequestContent(100, 'provider_x'));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayRequestContent(101, 'provider_x'));
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/snapshot_block/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS a mixed base/relay pair (content family mismatch)', async function () {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayRequestContent(100, 'provider_x'));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, baseAttestContent('e2'.repeat(32)));
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/ATTEST content family mismatch/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS a REQUEST-vs-RESPONSE pair (relay phase mismatch)', async function () {
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayRequestContent(100, 'provider_x'));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayResponseContent(100, 'e2'.repeat(32)));
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/relay phase mismatch/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS a relay proof that declares the base engine capability', async function () {
        // CAPABILITY stays derived, never trusted: the family names the governing set.
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayRequestContent(100, 'provider_x'));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RELAY_ROUND, 0, relayRequestContent(100, 'provider_y'));
        const d = data();
        await handler.parse(params('attestation', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/CAPABILITY \(does not match engine\)/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('still resolves a BASE v1 ATTEST double-sign from the mirrored request row', async function () {
        indexer.indexerDb.getAttestationRequestById.resolves({ block_index: 90 });
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, 'req_1', 0, baseAttestContent('e1'.repeat(32)));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, 'req_1', 0, baseAttestContent('e2'.repeat(32)));
        const d = data();
        await handler.parse(params('attestation', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.getAttestationRequestById.calledWith('req_1'));
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['attestation', 90]);
    });

    describe('_bountyTreasurySplit', function () {
        function withSlashConfig(cfg) {
            indexer.config.STAKING = { CAPABILITIES: { cross_chain: { MIN_STAKE: '5000', SLASH: cfg } } };
        }

        it('pure burn when no SLASH config (bounty 0, no treasury credit)', function () {
            // Explicit no-SLASH config: the real BTC.js now ships SLASH defaults, so assert
            // the absent-config path against a config that deliberately omits the SLASH block.
            indexer.config.STAKING = { CAPABILITIES: { cross_chain: { MIN_STAKE: '5000' } } };
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

        it('raises a sub-floor bounty to BOUNTY_FLOOR (cost-coverage on small bonds)', function () {
            withSlashConfig({ BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000' });   // 5% of 500 = 25 < floor 50
            const s = handler._bountyTreasurySplit('cross_chain', '500');
            assert.strictEqual(Number(s.bounty), 50);    // floor wins over the 25 the bps would give
            assert.strictEqual(Number(s.treasury), 450); // remainder burned (no TREASURY_ADDRESS)
            assert.strictEqual(s.treasuryAddr, null);
        });

        it('clamps the floor to the bond: a sub-floor bond never mints', function () {
            withSlashConfig({ BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000' });
            const s = handler._bountyTreasurySplit('cross_chain', '30');   // bond < floor
            assert.strictEqual(Number(s.bounty), 30);    // pays the whole bond, not 50
            assert.strictEqual(Number(s.treasury), 0);
            // Conservation: never pays out more than was burned.
            assert.strictEqual(Number(indexer.util.bcadd(s.bounty, s.treasury, 8)), 30);
        });

        it('the cap still wins over the floor when both are set', function () {
            withSlashConfig({ BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000', BOUNTY_CAP: '40.00000000' });
            const s = handler._bountyTreasurySplit('cross_chain', '5000');  // 5% = 250, floor 50, cap 40
            assert.strictEqual(Number(s.bounty), 40);    // cap is the hard ceiling, applied last
        });

        it('XCONFIG reads config.CONFIG_SLASH (whole-federation, no CAPABILITIES home)', function () {
            indexer.config.CONFIG_SLASH = { BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000', BOUNTY_CAP: '1000.00000000' };
            const s = handler._bountyTreasurySplit('config', '5000');
            assert.strictEqual(Number(s.bounty), 250);   // 5% of 5000
            assert.strictEqual(Number(s.treasury), 4750);
            assert.strictEqual(s.treasuryAddr, null);     // burned
        });

        it('XCONFIG is a pure burn when no CONFIG_SLASH is configured', function () {
            delete indexer.config.CONFIG_SLASH;
            const s = handler._bountyTreasurySplit('config', '5000');
            assert.strictEqual(Number(s.bounty), 0);
            assert.strictEqual(Number(s.treasury), 5000);
            assert.strictEqual(s.treasuryAddr, null);
        });
    });
});

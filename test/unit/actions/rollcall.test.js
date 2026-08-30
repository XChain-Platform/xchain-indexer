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
// AT7: every `invalid:` reason the ROLLCALL handler can return, falsified once
// on the chain that judges it.
//
// The handler decides STRUCTURE ONLY, and that boundary is the thing worth
// testing. It has no BTC view, so it cannot check LEDGER_HASH against anything
// and must not try; every question about who the signers are is answered at the
// BTC epoch close. So these tests assert two different properties: that each
// malformed shape is rejected with its own reason, and that the handler does NOT
// reach for verdicts it has no standing to make.

process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Rollcall = require('../../../src/actions/rollcall.js');
const eq       = require('../../../src/equivocation_header.js');
const rca      = require('../../../src/rollcall_activation.js');

const NETWORK = 'regtest';
const EPOCH   = 30;                       // ROLLCALL_INTERVAL_BLOCKS.regtest
const LEDGER  = 'ab'.repeat(32);

function identity(){
    let { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        pubkey: publicKey.export({ format: 'der', type: 'spki' }).slice(12).toString('hex'),
        priv:   privateKey
    };
}

// The canonical the hub signs and the BTC close re-verifies. Built from the
// CARRIED fields, so a roll call cannot be pre-signed before its epoch block exists.
function signFor(id, epochHeight, ledgerHash){
    let canon = eq.buildEquivCanonical(eq.ENGINE_TAGS.ROLLCALL, String(epochHeight), 0,
                                       NETWORK + '|' + epochHeight + '|' + ledgerHash);
    return crypto.sign(null, Buffer.from(canon, 'utf8'), id.priv).toString('hex');
}

// params[0] is VERSION; actions.js splits the wire string this way.
function paramsFor(over){
    let o = Object.assign({ epoch: EPOCH, ledger: LEDGER, publisher: null, sigs: [], count: null }, over || {});
    let pub = o.publisher === null ? o.sigs[0].pubkey : o.publisher;
    let p = ['ROLLCALL', String(o.epoch), o.ledger, pub,
             String(o.count === null ? o.sigs.length : o.count)];
    for(let s of o.sigs) p.push(s.pubkey, s.sig);
    return p;
}

// getTestConfig() force-sets INDEXER_COIN=BTC and returns the config MODULE's
// single cached object, so every mock indexer shares one config. Mutating it in
// place leaks into every later test in the file (which is how the first draft of
// this suite turned "wrong chain" into six spurious failures). Each test gets its
// own shallow copy instead, and ROLLCALL is DOGE-judged, so DOGE is the default.
function mockIndexer(coin){
    let indexer = createMockIndexer();
    indexer.config = Object.assign({}, indexer.config, { COIN: coin || 'DOGE', NETWORK: NETWORK });
    // insertRollcallSigners postdates the shared mock db, so stub it here.
    indexer.indexerDb.insertRollcallSigners = sinon.stub().resolves(0);
    return indexer;
}

async function run(params, dataOver, coin){
    let indexer = mockIndexer(coin);
    let handler = new Rollcall(indexer);
    let data = createBaseData(Object.assign({ FORMAT: 0, BLOCK_INDEX: 100, ACTION_INDEX: 1 }, dataOver || {}));
    let out = await handler.parse(params, data, null);
    return { out, indexer };
}

describe('ROLLCALL handler (§3.3) - AT7 reason falsification', function(){

    let signer;
    before(function(){ signer = identity(); });

    function goodSigs(){
        return [{ pubkey: signer.pubkey, sig: signFor(signer, EPOCH, LEDGER) }];
    }

    it('accepts a well-formed roll call and indexes only the VERIFIED signers', async function(){
        let { out, indexer } = await run(paramsFor({ sigs: goodSigs() }));
        assert.strictEqual(out['STATUS'], 'valid');
        assert.strictEqual(indexer.indexerDb.insertRollcallSigners.callCount, 1);
        let rows = indexer.indexerDb.insertRollcallSigners.firstCall.args[0];
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].pubkey, signer.pubkey);
        assert.strictEqual(rows[0].epoch_height, EPOCH);
    });

    it('invalid: VERSION (unknown) - an unrecognised wire version', async function(){
        let { out } = await run(paramsFor({ sigs: goodSigs() }), { FORMAT: 7 });
        // parse() dispatches on VERSION and returns undefined for a version it does
        // not implement, so nothing is indexed under a shape nobody can read.
        assert.strictEqual(out, undefined);
    });

    it('invalid: ROLLCALL only valid on DOGE - the wrong chain judging it', async function(){
        let { out, indexer } = await run(paramsFor({ sigs: goodSigs() }), null, 'BTC');
        assert.strictEqual(out['STATUS'], 'invalid: ROLLCALL only valid on DOGE');
        assert.strictEqual(indexer.indexerDb.insertRollcallSigners.callCount, 0);
    });

    it('invalid: VERSION (unknown) - an epoch below ROLLCALL_ACTIVATION is inert', async function(){
        // Keyed on the carried BTC epoch height, not this chain's local height, so a
        // pre-activation roll call is inert on DOGE and BTC alike with no second flag day.
        let saved = rca.ROLLCALL_ACTIVATION[NETWORK];
        rca.ROLLCALL_ACTIVATION[NETWORK] = 600;
        try {
            let { out } = await run(paramsFor({ sigs: goodSigs() }));
            assert.strictEqual(out['STATUS'], 'invalid: VERSION (unknown)');
        } finally { rca.ROLLCALL_ACTIVATION[NETWORK] = saved; }
    });

    it('invalid: EPOCH_HEIGHT - a height that is not an epoch boundary', async function(){
        let { out } = await run(paramsFor({ epoch: EPOCH + 1, sigs: goodSigs() }));
        assert.strictEqual(out['STATUS'], 'invalid: EPOCH_HEIGHT');
    });

    it('invalid: LEDGER_HASH - not 64 hex', async function(){
        let { out } = await run(paramsFor({ ledger: 'nope', sigs: goodSigs() }));
        assert.strictEqual(out['STATUS'], 'invalid: LEDGER_HASH');
    });

    it('invalid: PUBLISHER - not 64 hex', async function(){
        let { out } = await run(paramsFor({ publisher: 'zz', sigs: goodSigs() }));
        assert.strictEqual(out['STATUS'], 'invalid: PUBLISHER');
    });

    it('invalid: SIG_COUNT - a declared count shorter than the pairs present', async function(){
        // A short count would let the trailing pairs ride unverified.
        let sigs = goodSigs();
        let { out } = await run(paramsFor({ sigs: sigs.concat(sigs), count: 1 }));
        assert.strictEqual(out['STATUS'], 'invalid: SIG_COUNT');
    });

    it('invalid: SIG_COUNT - a declared count longer than the pairs present', async function(){
        let { out } = await run(paramsFor({ sigs: goodSigs(), count: 5 }));
        assert.strictEqual(out['STATUS'], 'invalid: SIG_COUNT');
    });

    it('invalid: SIG_COUNT - a roll call whose every signature fails to verify', async function(){
        let { out } = await run(paramsFor({ sigs: [{ pubkey: signer.pubkey, sig: '1'.repeat(128) }] }));
        assert.strictEqual(out['STATUS'], 'invalid: SIG_COUNT');
    });

    it('invalid: ROLLCALL (not batchable)', async function(){
        // The check lives in the handler rather than the BATCH cap table on purpose: a
        // row added to that table applies retroactively and would fork a replay.
        let { out } = await run(paramsFor({ sigs: goodSigs() }), { BATCH_POSITION: 0 });
        assert.strictEqual(out['STATUS'], 'invalid: ROLLCALL (not batchable)');
    });

    describe('the boundary the handler must not cross', function(){

        it('does NOT reject a LEDGER_HASH that disagrees with any BTC state', async function(){
            // The DOGE indexer has no BTC view and no way to know which hash is right.
            // Judging here would let a DOGE-side opinion decide a BTC membership question.
            // A well-formed hash is stored; the close discards it if it is not the one.
            let other = 'cd'.repeat(32);
            let sigs  = [{ pubkey: signer.pubkey, sig: signFor(signer, EPOCH, other) }];
            let { out, indexer } = await run(paramsFor({ ledger: other, sigs }));
            assert.strictEqual(out['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.insertRollcallSigners.firstCall.args[0][0].ledger_hash, other);
        });

        it('a garbage pair for a key cannot suppress that key\'s real signature', async function(){
            // Marking a pubkey "seen" on first encounter rather than after it verifies
            // would let one junk pair silence a live validator, which reads as an absence
            // and, over K epochs, evicts it. Order the junk FIRST to drive exactly that.
            let good = goodSigs()[0];
            let sigs = [{ pubkey: signer.pubkey, sig: '2'.repeat(128) }, good];
            let { out, indexer } = await run(paramsFor({ sigs }));
            assert.strictEqual(out['STATUS'], 'valid');
            let rows = indexer.indexerDb.insertRollcallSigners.firstCall.args[0];
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].sig, good.sig, 'the REAL signature must survive the junk one');
        });

        it('indexes a partial set rather than failing the whole action', async function(){
            // Union semantics: a publisher can add signers but never remove them, so one
            // bad pair among good ones must not discard the good ones.
            let other = identity();
            let sigs  = goodSigs().concat([{ pubkey: other.pubkey, sig: '3'.repeat(128) }]);
            let { out, indexer } = await run(paramsFor({ sigs }));
            assert.strictEqual(out['STATUS'], 'valid');
            assert.strictEqual(indexer.indexerDb.insertRollcallSigners.firstCall.args[0].length, 1);
        });
    });
});

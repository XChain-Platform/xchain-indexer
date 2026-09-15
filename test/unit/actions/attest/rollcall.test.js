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
// Every `invalid:` reason the ROLLCALL handler can return, falsified once
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
const sinon  = require('sinon');

const {
    EPOCH, GATES, LEDGER, NETWORK, Rollcall, identity, mockIndexer, paramsFor,
    paramsForV1, rca, rga, run, signFor, signForV1,
} = require('./rollcall.test/helpers/rollcall.js');

let signer, savedActivation, savedGates;

// The handler only reaches its falsification reasons on an ARMED network; below
// activation every roll call is inert and reports "VERSION (unknown)", which
// would turn this whole suite green for the wrong reason. Regtest went INERT on
// 2026-08-31 (a single-coin BTC regtest venue has no DOGE peer to prove a close),
// so the suite arms it for its own duration. The inert path keeps its own test
// below, which sets its own height rather than relying on the shipped value.
function setupRollcall(){
    signer = identity();
    savedActivation = rca.ROLLCALL_ACTIVATION[NETWORK];
    rca.ROLLCALL_ACTIVATION[NETWORK] = 0;
}

function restoreRollcall(){ rca.ROLLCALL_ACTIVATION[NETWORK] = savedActivation; }

function goodSigs(){
    return [{ pubkey: signer.pubkey, sig: signFor(signer, EPOCH, LEDGER) }];
}

function saveGates(){ savedGates = rga.ROLLCALL_GATES_ACTIVATION[NETWORK]; }
function restoreGates(){
    rga.ROLLCALL_GATES_ACTIVATION[NETWORK] = savedGates;
    // Each case builds its own mock indexer, and the GATES table case builds
    // eight; without this the shared sinon sandbox passes its leak threshold.
    sinon.restore();
}

function armGates(h){ rga.ROLLCALL_GATES_ACTIVATION[NETWORK] = (h === undefined ? 0 : h); }
function goodV1(gates){
    let g = gates === undefined ? GATES : gates;
    return [{ pubkey: signer.pubkey, sig: signForV1(signer, EPOCH, LEDGER, g) }];
}
function runV1(params, dataOver, coin){
    return run(params, Object.assign({ FORMAT: 1 }, dataOver || {}), coin);
}

describe('ROLLCALL handler (§3.3) - AT7 reason falsification', function(){
    before(setupRollcall);
    after(restoreRollcall);

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
});

describe('ROLLCALL handler (§3.3) - AT7 reason falsification', function(){
    before(setupRollcall);
    after(restoreRollcall);
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
});

describe('ROLLCALL handler (§3.3) - AT7 reason falsification', function(){
    before(setupRollcall);
    after(restoreRollcall);
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

        it('a v0 row carries a null gates column', async function(){
            // The column exists for both versions; below the gates height there is no
            // list to record, and a '' would read downstream as "this signer named no
            // gates" rather than "this epoch predates the field".
            let { indexer } = await run(paramsFor({ sigs: goodSigs() }));
            assert.strictEqual(indexer.indexerDb.insertRollcallSigners.firstCall.args[0][0].gates, null);
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

describe('ROLLCALL handler (§3.3) - AT7 reason falsification', function(){
    before(setupRollcall);
    after(restoreRollcall);
    // ── ROLLCALL v1: the GATES form ──────────────────────────────────────────
    //
    // EXACTLY ONE version is legal per epoch, decided by the carried EPOCH_HEIGHT
    // against ROLLCALL_GATES_ACTIVATION. The threshold is stubbed rather than armed
    // through XC_ROLLCALL_GATES_REGTEST_ACTIVATION because that variable is read
    // ONCE at require time: setting it here would arm the module for every suite
    // mocha loads in the same process. The env grammar is the gate module's own test.

    describe('v1 (GATES)', function(){

        beforeEach(saveGates);
        afterEach(restoreGates);

        it('the handler advertises formats[1] with GATES between PUBLISHER and SIG_COUNT', function(){
            let handler = new Rollcall(mockIndexer());
            assert.strictEqual(handler.formats[1],
                'VERSION|EPOCH_HEIGHT|LEDGER_HASH|PUBLISHER|GATES|SIG_COUNT|PUBKEY|SIG|...');
        });

        it('accepts a v1 roll call, verifies over the GATES canonical and stores the raw list', async function(){
            armGates();
            let { out, indexer } = await runV1(paramsForV1({ sigs: goodV1() }));
            assert.strictEqual(out['STATUS'], 'valid');
            let rows = indexer.indexerDb.insertRollcallSigners.firstCall.args[0];
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].pubkey, signer.pubkey);
            assert.strictEqual(rows[0].epoch_height, EPOCH);
            // The RAW carried string: the BTC close rebuilds the canonical from this
            // column, so any normalisation here breaks every signature it re-verifies.
            assert.strictEqual(rows[0].gates, GATES);
        });
    });
});

describe('ROLLCALL handler (§3.3) - AT7 reason falsification', function(){
    before(setupRollcall);
    after(restoreRollcall);
    describe('v1 (GATES)', function(){
        beforeEach(saveGates);
        afterEach(restoreGates);
        it('a signature over the GATES-STRIPPED v0 canonical does not verify in a v1 action', async function(){
            // The drop-the-gates attack: a parser that rebuilt the v0 canonical for a
            // v1 action would accept these and record a list nobody signed.
            armGates();
            let sigs = [{ pubkey: signer.pubkey, sig: signFor(signer, EPOCH, LEDGER) }];
            let { out, indexer } = await runV1(paramsForV1({ sigs }));
            assert.strictEqual(out['STATUS'], 'invalid: SIG_COUNT');
            assert.strictEqual(indexer.indexerDb.insertRollcallSigners.callCount, 0);
        });

        it('a signature over a DIFFERENT gate list does not verify', async function(){
            // Signers sign the PUBLISHER's list, so a build one gate ahead signs other
            // bytes and is simply absent for the epoch (roll BETWEEN epochs).
            armGates();
            let other = GATES + ',zzz_module.ZZZ_EXPORT';
            let sigs  = [{ pubkey: signer.pubkey, sig: signForV1(signer, EPOCH, LEDGER, other) }];
            let { out } = await runV1(paramsForV1({ sigs }));
            assert.strictEqual(out['STATUS'], 'invalid: SIG_COUNT');
        });

        it('invalid: ROLLCALL v1 before gates activation', async function(){
            armGates(EPOCH + 1);
            let { out, indexer } = await runV1(paramsForV1({ sigs: goodV1() }));
            assert.strictEqual(out['STATUS'], 'invalid: ROLLCALL v1 before gates activation');
            assert.strictEqual(indexer.indexerDb.insertRollcallSigners.callCount, 0);
        });
    });
});

describe('ROLLCALL handler (§3.3) - AT7 reason falsification', function(){
    before(setupRollcall);
    after(restoreRollcall);
    describe('v1 (GATES)', function(){
        beforeEach(saveGates);
        afterEach(restoreGates);
        it('invalid: ROLLCALL v1 before gates activation - the INERT null placeholder', async function(){
            // `0 >= null` is true in JS; only the isFinite guard keeps an unarmed
            // network from accepting a v1 roll call at height 0.
            rga.ROLLCALL_GATES_ACTIVATION[NETWORK] = null;
            let { out } = await runV1(paramsForV1({ sigs: goodV1() }));
            assert.strictEqual(out['STATUS'], 'invalid: ROLLCALL v1 before gates activation');
        });

        it('invalid: ROLLCALL v0 after gates activation', async function(){
            // The other half of "one legal version per epoch": accepting both would let
            // a publisher choose which canonical the epoch's signers are judged against.
            armGates();
            let { out, indexer } = await run(paramsFor({ sigs: goodSigs() }));
            assert.strictEqual(out['STATUS'], 'invalid: ROLLCALL v0 after gates activation');
            assert.strictEqual(indexer.indexerDb.insertRollcallSigners.callCount, 0);
        });

        it('invalid: GATES - empty, malformed, out of order or duplicated', async function(){
            armGates();
            const cases = {
                'empty':        '',
                'no module':    'ROLLCALL_ACTIVATION',
                'bad chars':    'rollcall activation.ROLLCALL_ACTIVATION',
                'empty token':  'a.B,,c.D',
                'descending':   'rollcall_activation.ROLLCALL_ACTIVATION,equivocation_header.EQUIV_HEADER_ACTIVATION',
                'duplicate':    'a.B,a.B',
                'space padded': 'a.B, c.D'
            };
            for(const [name, gates] of Object.entries(cases)){
                let { out, indexer } = await runV1(paramsForV1({ gates, sigs: goodV1(gates) }));
                assert.strictEqual(out['STATUS'], 'invalid: GATES', name);
                assert.strictEqual(indexer.indexerDb.insertRollcallSigners.callCount, 0, name);
            }
            // ...and a well-formed ascending pair of the same shape is accepted, so the
            // cases above are failing on the rule and not on the fixture.
            let ok = 'a.B,c.D';
            let { out } = await runV1(paramsForV1({ gates: ok, sigs: goodV1(ok) }));
            assert.strictEqual(out['STATUS'], 'valid');
        });
    });
});

describe('ROLLCALL handler (§3.3) - AT7 reason falsification', function(){
    before(setupRollcall);
    after(restoreRollcall);
    describe('v1 (GATES)', function(){
        beforeEach(saveGates);
        afterEach(restoreGates);
        it('invalid: SIG_COUNT - the count is read at the v1 offset, not the v0 one', async function(){
            // A parser still reading params[4] would parse GATES as SIG_COUNT and read
            // the pairs one field short of where they are.
            armGates();
            let { out } = await runV1(paramsForV1({ sigs: goodV1(), count: 2 }));
            assert.strictEqual(out['STATUS'], 'invalid: SIG_COUNT');
        });

        it('keeps the DOGE-only guard and the first-seen semantics', async function(){
            armGates();
            let { out } = await runV1(paramsForV1({ sigs: goodV1() }), null, 'BTC');
            assert.strictEqual(out['STATUS'], 'invalid: ROLLCALL only valid on DOGE');

            // A junk pair ordered FIRST must not suppress the real signature.
            let good = goodV1()[0];
            let sigs = [{ pubkey: signer.pubkey, sig: '2'.repeat(128) }, good];
            let r = await runV1(paramsForV1({ sigs }));
            assert.strictEqual(r.out['STATUS'], 'valid');
            let rows = r.indexer.indexerDb.insertRollcallSigners.firstCall.args[0];
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].sig, good.sig);
            assert.strictEqual(rows[0].gates, GATES);
        });
    });
});

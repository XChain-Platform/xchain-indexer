/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Part of the ROLLCALL epoch close suite whose entry is
 * test/unit/rollcall_close.test.js: ROLLCALL v1, the gates canonical and the
 * rollcall_gates write, and the v0 form below ROLLCALL_GATES_ACTIVATION. Every
 * block repeats the suite title, so each full test title is unchanged.
 *
 ********************************************************************/
const assert = require('assert');
const rc  = require('../../../src/consensus/rollcall_close.js');
const rga = require('../../../src/rollcall_gates_activation.js');

const { NETWORK, EPOCH, CLOSE, LEDGER, CONFIG, UTIL, signFor, signV1For, stubProof, federation, answerWith, dbFor, armRollcall } = require('./helpers/rollcall_fixtures.js');

// ROLLCALL v1. At or above ROLLCALL_GATES_ACTIVATION the signed
// canonical commits to sha256(GATES) and a ROLLED epoch records each verified
// signer's list, because rollcall_gates is the only BTC-side artifact the
// rules-aware attestation set can read.
//
// Every case here is about the eviction cost of getting the FORM wrong: a row
// whose form disagrees with its epoch is not a valid signer, and a signer that
// signed a different list verified against nothing, so both are absences and
// two absences evict. That is the price of rolling a fleet across
// an epoch, and it must fall out of the code, not out of a comment.

// Shaped like the real field: sorted, comma-joined `<module>.<EXPORT>` keys.
const GATES = 'anchor_reward_activation.ANCHOR_REWARD_ACTIVATION,' +
              'attest_zero_conf_activation.ATTEST_ZERO_CONF_ACTIVATION,' +
              'rollcall_activation.ROLLCALL_ACTIVATION';
// One gate short: what a validator a release behind the publisher would sign.
const GATES_OTHER = 'anchor_reward_activation.ANCHOR_REWARD_ACTIVATION,' +
                    'rollcall_activation.ROLLCALL_ACTIVATION';

// Arms ROLLCALL_GATES_ACTIVATION at genesis for one v1 block and puts the venue
// value back after it.
function armGatesV1(){
    let savedGates;
    before(function(){
        savedGates = rga.ROLLCALL_GATES_ACTIVATION[NETWORK];
        rga.ROLLCALL_GATES_ACTIVATION[NETWORK] = 0;   // epoch 30 is a v1 epoch
    });
    after(function(){ rga.ROLLCALL_GATES_ACTIVATION[NETWORK] = savedGates; });
}

// A decided answer whose `presentIdx` signed the v1 canonical over the
// PUBLISHER's list, which is the string every row of one action carries.
function answerV1(fed, presentIdx, over){
    let signers = {};
    for(let i of presentIdx){
        signers[fed.ids[i].pubkey] = {
            sig:          signV1For(fed.ids[i], EPOCH, LEDGER, GATES),
            ledger_hash:  LEDGER,
            publisher:    fed.ids[0].pubkey,
            action_index: 1, block_index: 10,
            gates:        GATES
        };
    }
    return Object.assign({ decided: true, hcut: 50, signers, publishers: {} }, over || {});
}

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('ROLLCALL v1: the gates canonical and the rollcall_gates write (§7.3, D85)', function(){

        armGatesV1();

        it('counts a v1 signer whose signature verifies over the gates canonical', async function(){
            let fed = federation(3);
            let db  = dbFor(fed);
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerV1(fed, [0,1,2])), UTIL);
            assert.strictEqual(db.writes.rollcalls[0].rolled, 1);
            assert.strictEqual(db.writes.absences.length, 0, 'a v1 signer is present, not absent');
        });

        it('writes one rollcall_gates row per verified signer, keyed to the epoch and the close block', async function(){
            let fed = federation(3);
            let db  = dbFor(fed);
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerV1(fed, [0,1,2])), UTIL);
            assert.strictEqual(db.writes.gates.length, 1, 'one write for the epoch');
            let w = db.writes.gates[0];
            assert.strictEqual(w.e, EPOCH);
            assert.strictEqual(w.c, CLOSE, 'close_block is the rollback anchor');
            assert.deepStrictEqual(w.rows.map((r) => r.pubkey).slice().sort(),
                                   fed.ids.map((i) => i.pubkey).slice().sort(),
                                   'one row per verified key, by PUBKEY not by source');
            // The list is stored split, so the filter compares gate keys, not a string.
            for(let r of w.rows) assert.deepStrictEqual(r.gates, GATES.split(','));
        });

        it('is ABSENT for a signer that signed a different list than the publisher\'s (§7.2)', async function(){
            // The cost of a fleet rolling across an epoch. The row carries the
            // publisher's GATES (there is one GATES per action), so a validator whose
            // build knew a shorter list signed different bytes and verifies against
            // nothing. It must be absent, and it must get no gates row: a row would
            // claim the publisher's list on a key that never accepted it.
            let fed = federation(4);
            let db  = dbFor(fed);
            let a = answerV1(fed, [0,1,2]);
            a.signers[fed.ids[3].pubkey] = {
                sig:          signV1For(fed.ids[3], EPOCH, LEDGER, GATES_OTHER),
                ledger_hash:  LEDGER,
                publisher:    fed.ids[0].pubkey,
                action_index: 1, block_index: 10,
                gates:        GATES
            };
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(a), UTIL);
            assert.deepStrictEqual(db.writes.absences.map((r) => r.source), ['src3']);
            assert.deepStrictEqual(db.writes.gates[0].rows.map((r) => r.pubkey).slice().sort(),
                                   fed.ids.slice(0, 3).map((i) => i.pubkey).slice().sort());
        });
    });
});

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('ROLLCALL v1: the gates canonical and the rollcall_gates write (§7.3, D85)', function(){

        armGatesV1();

        it('is ABSENT for a v0 row at a v1 epoch, however well its v0 signature verifies', async function(){
            let fed = federation(4);
            let db  = dbFor(fed);
            let a = answerV1(fed, [0,1,2]);
            a.signers[fed.ids[3].pubkey] = {
                sig:          signFor(fed.ids[3], EPOCH, LEDGER),   // valid v0 signature
                ledger_hash:  LEDGER,
                publisher:    fed.ids[0].pubkey,
                action_index: 1, block_index: 10,
                gates:        null                                 // but no list at all
            };
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(a), UTIL);
            assert.deepStrictEqual(db.writes.absences.map((r) => r.source), ['src3'],
                'the epoch decides the form; a v0 row cannot count at a v1 epoch');
            assert.strictEqual(db.writes.gates[0].rows.length, 3);
        });

        it('is ABSENT for an EMPTY gates string, which is never a v1 list', async function(){
            let fed = federation(4);
            let db  = dbFor(fed);
            let a = answerV1(fed, [0,1,2]);
            a.signers[fed.ids[3].pubkey] = {
                sig:          signV1For(fed.ids[3], EPOCH, LEDGER, ''),
                ledger_hash:  LEDGER,
                publisher:    fed.ids[0].pubkey,
                action_index: 1, block_index: 10,
                gates:        ''
            };
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(a), UTIL);
            assert.deepStrictEqual(db.writes.absences.map((r) => r.source), ['src3']);
            // And no [''] row reaches the table, which the filter would read as a key
            // that accepted a gate named the empty string.
            assert.strictEqual(db.writes.gates[0].rows.length, 3);
        });

        it('writes NO gates rows for an UNROLLED v1 epoch, whatever verified', async function(){
            // An unrolled epoch decided nothing about membership. Recording its lists
            // would let a partition's partial answer become the set the filter reads.
            let fed = federation(4);
            let db  = dbFor(fed);
            let n = await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerV1(fed, [0])), UTIL);
            assert.strictEqual(n, 1);
            assert.strictEqual(db.writes.rollcalls[0].rolled, 0);
            assert.strictEqual(db.writes.gates.length, 0, 'an unrolled epoch writes no gates rows');
        });
    });
});

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('ROLLCALL v1: the gates canonical and the rollcall_gates write (§7.3, D85)', function(){

        armGatesV1();

        it('names why each key was dropped on the close line, so a discarded federation is not read as an absence', async function(){
            // The shape that motivated this: rows of the wrong form for the epoch (here
            // v0 rows at a v1 epoch) closed "present 0/4" with nothing on the line to say
            // a canonical mismatch, not a silent federation, was the cause.
            let fed = federation(4);
            let db  = dbFor(fed);
            let a = answerV1(fed, [0,1,2]);
            for(let i of [0,1,2]) a.signers[fed.ids[i].pubkey].gates = null;
            let lines = [];
            let orig  = console.log;
            console.log = function(){ lines.push(Array.prototype.join.call(arguments, ' ')); };
            try { await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(a), UTIL); }
            finally { console.log = orig; }
            assert.strictEqual(db.writes.rollcalls[0].rolled, 0);
            let line = lines.find((l) => l.indexOf('ROLLCALL close') !== -1 && l.indexOf('UNROLLED') !== -1);
            assert.ok(line, 'the close logged its UNROLLED line');
            assert.ok(line.indexOf('dropped[no_row=1 ledger_hash=0 form=3 sig=0 v1 epoch]') !== -1,
                'the close line must tally the drops by reason; got: ' + line);
        });

        it('writes no gates rows when a rolled epoch verified nobody it could record', async function(){
            // Degenerate but reachable: the write is skipped rather than handing the db
            // an empty row list.
            let fed = federation(1);
            let db  = dbFor(fed);
            let a = answerV1(fed, []);
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(a), UTIL);
            assert.strictEqual(db.writes.gates.length, 0);
        });
    });
});

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('below ROLLCALL_GATES_ACTIVATION: v0, byte for byte', function(){

        let savedGates;
        before(function(){
            savedGates = rga.ROLLCALL_GATES_ACTIVATION[NETWORK];
            rga.ROLLCALL_GATES_ACTIVATION[NETWORK] = null;   // inert, whatever the venue armed
        });
        after(function(){ rga.ROLLCALL_GATES_ACTIVATION[NETWORK] = savedGates; });

        it('never touches rollcall_gates', async function(){
            let fed = federation(3);
            let db  = dbFor(fed);
            db.insertRollcallGates = async () => { throw new Error('insertRollcallGates called below the height'); };
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0,1,2])), UTIL);
            assert.strictEqual(db.writes.rollcalls[0].rolled, 1);
            assert.strictEqual(db.writes.gates.length, 0);
        });

        it('is ABSENT for a v1 row at a v0 epoch, a form that epoch cannot carry', async function(){
            let fed = federation(4);
            let db  = dbFor(fed);
            const GATES = 'rollcall_activation.ROLLCALL_ACTIVATION';
            let a = answerWith(fed, [0,1,2]);
            a.signers[fed.ids[3].pubkey] = {
                sig:          signV1For(fed.ids[3], EPOCH, LEDGER, GATES),
                ledger_hash:  LEDGER,
                publisher:    fed.ids[0].pubkey,
                action_index: 1, block_index: 10,
                gates:        GATES
            };
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(a), UTIL);
            assert.deepStrictEqual(db.writes.absences.map((r) => r.source), ['src3']);
        });

        it('still counts a v0 signer whose row carries an empty gates string', async function(){
            // The false-absence hazard the normalization closes: a column default of ''
            // upstream must not turn an honest v0 signer into an absence, because two
            // absences evict.
            let fed = federation(4);
            let db  = dbFor(fed);
            let a = answerWith(fed, [0,1,2,3]);
            a.signers[fed.ids[3].pubkey].gates = '';
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(a), UTIL);
            assert.strictEqual(db.writes.rollcalls[0].rolled, 1);
            assert.strictEqual(db.writes.absences.length, 0, 'an empty gates string is not a v1 row');
        });
    });
});

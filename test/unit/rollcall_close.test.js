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
 * The ROLLCALL epoch close: quorum gate, absence pinning, the K-streak and
 * eviction.
 *
 * WHAT THESE TESTS ARE FOR. An absence costs a live validator its stake, so
 * every case where the close could be WRONG matters more than the case where it
 * works. The happy path is a handful of these; the rest are refusals, skips and
 * deferrals. In particular the K-streak has two opposite failure modes and both
 * are driven here: ending a streak that should have continued (a source dodges
 * eviction forever by dipping under the floor), and continuing one that should
 * have ended (a validator that was demonstrably present gets evicted).
 *
 ********************************************************************/
const assert = require('assert');

const rc  = require('../../src/consensus/rollcall_close.js');
const { RollcallProofUnavailableError } = require('../../src/consensus/rollcall_proof_client.js');

// The fixtures and the hook pair that arms ROLLCALL are shared with the parts under
// test/unit/rollcall_close.test/, which hold the K-streak and the eviction effect,
// the publish reward with leader election and source ordering, and ROLLCALL v1.
// Every block, here and there, repeats the suite title below, so each full test
// title is unchanged.
const {
    NETWORK, EPOCH, WINDOW, CLOSE, LEDGER, CONFIG, UTIL,
    signFor, stubProof, federation, answerWith, dbFor, armRollcall
} = require('./rollcall_close.test/helpers/rollcall_fixtures.js');

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('when the close does not run at all', function(){

        it('is a no-op off BTC, where no stake row lives', async function(){
            let db = dbFor(federation(3));
            let n = await rc.closeRollcallEpochs(db, { COIN: 'DOGE', NETWORK }, CLOSE, stubProof(null), UTIL);
            assert.strictEqual(n, 0);
            assert.strictEqual(db.writes.rollcalls.length, 0);
        });

        it('is a no-op at a block that closes no epoch', async function(){
            let db = dbFor(federation(3));
            let n = await rc.closeRollcallEpochs(db, CONFIG, CLOSE + 1, stubProof(null), UTIL);
            assert.strictEqual(n, 0);
            assert.strictEqual(db.writes.rollcalls.length, 0);
        });
    });
});

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('deferral: every way of not knowing', function(){

        it('defers when the DOGE peer cannot decide, rather than reading silence as absence', async function(){
            let fed = federation(3);
            let db  = dbFor(fed);
            await assert.rejects(
                () => rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof({ decided: false, reason: 'unreachable' }), UTIL),
                (e) => e instanceof RollcallProofUnavailableError && /unreachable/.test(e.message));
            // The critical assertion: nothing was written. A deferred block must leave
            // no verdict behind, or the retry would double-write it.
            assert.strictEqual(db.writes.rollcalls.length, 0);
            assert.strictEqual(db.writes.absences.length, 0);
        });

        it('defers when the window-end block has no stored block_time', async function(){
            let fed = federation(3);
            let db  = dbFor(fed);
            delete db.blocks[EPOCH + WINDOW];
            await assert.rejects(
                () => rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0,1,2])), UTIL),
                RollcallProofUnavailableError);
        });

        it('defers when the epoch block has no stored ledger_hash', async function(){
            let fed = federation(3);
            let db  = dbFor(fed);
            delete db.blocks[EPOCH];
            await assert.rejects(
                () => rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0,1,2])), UTIL),
                RollcallProofUnavailableError);
        });
    });
});

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('the quorum gate: an unrolled epoch counts for nobody', function(){

        it('writes an unrolled row and NO absences when the responsible read was truncated', async function(){
            let fed = federation(3);
            let db  = dbFor(fed);
            db.responsible.truncated = true;
            let n = await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [])), UTIL);
            assert.strictEqual(n, 1);
            assert.strictEqual(db.writes.rollcalls[0].rolled, 0);
            assert.strictEqual(db.writes.rollcalls[0].pinned, null);
            assert.strictEqual(db.writes.absences.length, 0);
        });

        it('writes an unrolled row and NO absences when the federation is empty', async function(){
            let db = dbFor({ ids: [], responsible: [] });
            let n  = await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(null), UTIL);
            assert.strictEqual(n, 1);
            assert.strictEqual(db.writes.rollcalls[0].rolled, 0);
            assert.strictEqual(db.writes.absences.length, 0);
        });

        it('evicts NOBODY when the present set is below threshold, however many are absent', async function(){
            let fed = federation(4);
            let db  = dbFor(fed);
            // One of four present: nowhere near 2/3 by weight.
            let n = await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0])), UTIL);
            assert.strictEqual(n, 1);
            assert.strictEqual(db.writes.rollcalls[0].rolled, 0);
            assert.strictEqual(db.writes.absences.length, 0, 'an unrolled epoch pins no absence');
            assert.strictEqual(db.writes.unstakes.length, 0);
            assert.strictEqual(db.writes.rewards.length, 0, 'an unrolled epoch pays no publish reward');
        });
    });
});

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('verification: only signatures bound to THIS chain count', function(){

        it('does not count a signature bound to a different ledger_hash', async function(){
            let fed = federation(4);
            let db  = dbFor(fed);
            // All three "signed", but one signed over a DIFFERENT epoch block. That is a
            // signature about a chain this node is not on, and it must not count as presence.
            let a = answerWith(fed, [0, 1, 2]);
            let wrong = 'ff'.repeat(32);
            a.signers[fed.ids[3].pubkey] = {
                sig: signFor(fed.ids[3], EPOCH, wrong), ledger_hash: wrong,
                publisher: fed.ids[0].pubkey, action_index: 1, block_index: 10
            };
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(a), UTIL);
            let absent = db.writes.absences.map((r) => r.source);
            assert.deepStrictEqual(absent, ['src3'], 'the wrongly-bound signer is absent, not present');
        });

        it('does not count a well-formed signature that simply does not verify', async function(){
            let fed = federation(4);
            let db  = dbFor(fed);
            let a = answerWith(fed, [0, 1, 2]);
            a.signers[fed.ids[3].pubkey] = {
                sig: '11'.repeat(64), ledger_hash: LEDGER,
                publisher: fed.ids[0].pubkey, action_index: 1, block_index: 10
            };
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(a), UTIL);
            assert.deepStrictEqual(db.writes.absences.map((r) => r.source), ['src3']);
        });
    });
});

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('verification: only signatures bound to THIS chain count', function(){

        it('does not count a VALID signature whose row mislabels the ledger_hash', async function(){
            // The strictness the close rule asks for, and it is not redundant with the
            // signature check: this signature verifies perfectly over this indexer's own
            // canonical, and only the row's carried ledger_hash field disagrees. The row
            // must be internally consistent to count, so a mislabeled row is discarded
            // rather than quietly accepted on the strength of its signature.
            let fed = federation(4);
            let db  = dbFor(fed);
            let a = answerWith(fed, [0, 1, 2]);
            a.signers[fed.ids[3].pubkey] = {
                sig:         signFor(fed.ids[3], EPOCH, LEDGER),   // valid over OUR canonical
                ledger_hash: 'ff'.repeat(32),                      // but the row says otherwise
                publisher:   fed.ids[0].pubkey, action_index: 1, block_index: 10
            };
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(a), UTIL);
            assert.deepStrictEqual(db.writes.absences.map((r) => r.source), ['src3'],
                'an internally inconsistent row is not a presence proof');
        });

        it('rolls and pins no absence when every source is present', async function(){
            let fed = federation(3);
            let db  = dbFor(fed);
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0,1,2])), UTIL);
            assert.strictEqual(db.writes.rollcalls[0].rolled, 1);
            // The close hands db.insertRollcall the source ARRAY; the JSON encoding is
            // the db layer's job, so this asserts the contract the close actually has.
            assert.deepStrictEqual(db.writes.rollcalls[0].pinned.slice().sort(), ['src0','src1','src2']);
            assert.strictEqual(db.writes.absences.length, 0);
        });
    });
});

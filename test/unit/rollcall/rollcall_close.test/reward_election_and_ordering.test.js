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
 * test/unit/rollcall_close.test.js: the publish reward, leader election parity
 * with the hub, and the UTF-8 byte order of the source set. Every block
 * repeats the suite title, so each full test title is unchanged.
 *
 ********************************************************************/
const assert = require('assert');
const crypto = require('crypto');

const rc  = require('../../../../src/consensus/rollcall_close.js');
const rca = require('../../../../src/consensus/gates/rollcall_gate.js');

const { NETWORK, EPOCH, CLOSE, CONFIG, UTIL, identity, stubProof, federation, answerWith, dbFor, armRollcall } = require('./helpers/rollcall_fixtures.js');

// The close sorts the source set once, and that one order is load-bearing three
// ways: it is the pinned responsible_set_json, it fixes the absence row order,
// and it fixes the sequence evictSource mints action_index values in.
//
// The fixture has to disagree with a bare .sort(): U+FFFD is one 0xFFFD code
// unit but EF BF BD in UTF-8, and U+10000 is the surrogate pair D800 DC00 but
// F0 90 80 80. An all-ASCII fixture cannot fail, which is why these two are here.
const SRC_FFFD   = 'src-�';
const SRC_10000  = 'src-\u{10000}';
const BYTE_ORDER = [SRC_FFFD, SRC_10000, 'src0', 'src1', 'src2'];

// Three ASCII sources carry the quorum; the two fixture sources are absent for K
// epochs, so both are evicted in the same close and their sweep order shows.
async function closeWithBothAbsent(){
    let present = federation(3);
    let a = identity(), b = identity();
    let fed = {
        ids: present.ids.concat([a, b]),
        responsible: present.responsible.concat([
            { pubkey: a.pubkey, source: SRC_10000, weight: '1.00000000' },
            { pubkey: b.pubkey, source: SRC_FFFD,  weight: '1.00000000' }
        ])
    };
    let db = dbFor(fed);
    db.rolledEpochs = [
        { epoch_height: EPOCH,      responsible_set_json: JSON.stringify(BYTE_ORDER) },
        { epoch_height: EPOCH - 30, responsible_set_json: JSON.stringify(BYTE_ORDER) }
    ];
    db.absencesBySource[SRC_10000] = [EPOCH - 30];
    db.absencesBySource[SRC_FFFD]  = [EPOCH - 30];
    db.sweepable[SRC_10000] = [{ signing_pubkey: a.pubkey, amount: '1.00000000' }];
    db.sweepable[SRC_FFFD]  = [{ signing_pubkey: b.pubkey, amount: '1.00000000' }];
    await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0, 1, 2])), UTIL);
    return db;
}

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('the publish reward', function(){

        it('pays the ELECTED leader, at the earn/materialisation heights the rollback keys on', async function(){
            let fed = federation(3);
            let db  = dbFor(fed);
            let leader = rc.hashOrder(rc.electionKey(NETWORK, EPOCH), fed.responsible.map((r) => r.pubkey))[0];
            let a = answerWith(fed, [0,1,2]);
            a.publishers[leader] = { action_index: 1, block_index: 10 };
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(a), UTIL);
            assert.strictEqual(db.writes.rewards.length, 1);
            let r = db.writes.rewards[0];
            assert.strictEqual(r.pk, leader);
            assert.strictEqual(r.type, 'rollcall_publish');
            assert.strictEqual(r.amt, rca.ROLLCALL_REWARD_AMOUNT);
            assert.strictEqual(r.ref, EPOCH,    'round_reference is the epoch');
            assert.strictEqual(r.blk, EPOCH,    'block_index is the EARN block');
            assert.strictEqual(r.derive, CLOSE, 'derive_block_index is the close, so a reorg into (E, C] deletes it');
            assert.strictEqual(r.qual, 0);
        });

        it('pays nothing when the leader published nothing', async function(){
            let fed = federation(3);
            let db  = dbFor(fed);
            await rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(answerWith(fed, [0,1,2])), UTIL);
            assert.strictEqual(db.writes.rewards.length, 0);
        });

        it('throws rather than silently skipping a refused reward write', async function(){
            // createValidatorReward returns false when its active-stake precondition
            // fails. The leader is in R(E) by construction, so a false here means the
            // node disagrees with its peers about the set: better to halt than to
            // derive a reward set nobody else has.
            let fed = federation(3);
            let db  = dbFor(fed);
            db.rewardResult = false;
            let leader = rc.hashOrder(rc.electionKey(NETWORK, EPOCH), fed.responsible.map((r) => r.pubkey))[0];
            let a = answerWith(fed, [0,1,2]);
            a.publishers[leader] = { action_index: 1, block_index: 10 };
            await assert.rejects(
                () => rc.closeRollcallEpochs(db, CONFIG, CLOSE, stubProof(a), UTIL),
                /reward write refused/);
        });
    });
});

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('leader election parity', function(){

        it('orders by sha256(key || pubkey) ascending, the hub\'s own ordering', async function(){
            // Byte-parity with StateAnchorPublisher.hashOrder. If these diverge, the BTC
            // side pays a validator the federation did not elect.
            let keys = Array.from({ length: 8 }, () => crypto.randomBytes(32).toString('hex'));
            let key  = rc.electionKey(NETWORK, EPOCH);
            let expected = keys.slice().map((pk) => ({
                pubkey: pk.toLowerCase(),
                hash: crypto.createHash('sha256').update(key, 'utf8').update(pk.toLowerCase(), 'utf8').digest('hex')
            })).sort((a, b) => (a.hash < b.hash) ? -1 : (a.hash > b.hash ? 1 : 0)).map((e) => e.pubkey);
            assert.deepStrictEqual(rc.hashOrder(key, keys), expected);
        });

        it('carries its own domain tag, so the anchor election and this one are independent', function(){
            assert.strictEqual(rc.electionKey('regtest', 30), 'XROLLCALL|regtest|30');
        });
    });
});

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('source ordering is UTF-8 byte order, the house consensus comparator', function(){
        it('has a fixture that actually separates the two orders', function(){
            // Without this, every assertion below would pass under the bare .sort() too.
            assert.deepStrictEqual([SRC_FFFD, SRC_10000].sort(), [SRC_10000, SRC_FFFD],
                'UTF-16 code-unit order puts U+10000 first');
            let bytes = [SRC_10000, SRC_FFFD].sort(
                (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
            assert.deepStrictEqual(bytes, [SRC_FFFD, SRC_10000], 'UTF-8 byte order puts U+FFFD first');
        });

        it('pins responsible_set_json in byte order', async function(){
            let db = await closeWithBothAbsent();
            assert.strictEqual(db.writes.rollcalls[0].rolled, 1);
            assert.deepStrictEqual(db.writes.rollcalls[0].pinned, BYTE_ORDER);
        });

        it('writes the absence rows in byte order', async function(){
            let db = await closeWithBothAbsent();
            assert.deepStrictEqual(db.writes.absences.map((r) => r.source), [SRC_FFFD, SRC_10000]);
        });
    });
});

describe('ROLLCALL epoch close (§3.4)', function(){
    armRollcall();

    describe('source ordering is UTF-8 byte order, the house consensus comparator', function(){
        it('evicts in byte order, so the minted action_index sequence is the same on every node', async function(){
            let db = await closeWithBothAbsent();
            assert.deepStrictEqual(db.sweepCalls.map((c) => c.src), [SRC_FFFD, SRC_10000]);
            assert.deepStrictEqual(db.writes.unstakes.map((u) => u.SOURCE), [SRC_FFFD, SRC_10000]);
            assert.deepStrictEqual(db.writes.actionIndexes.map((a) => a.index), [9000, 9001]);
        });
    });
});

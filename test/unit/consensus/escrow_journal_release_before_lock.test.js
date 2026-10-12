/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const W = require('../../../src/consensus/escrow_journal_writer.js');
const { journalOverlay, liveSet, compareIncrementalToReplay } = require('../../../bin/shadow-dryrun-escrow-leaf.js');
const ESC = require('../../../src/consensus/escrow_leaf_subtree.js');
const SC = require('../../../src/state_commitment/index.js');
const M = require('../../../src/consensus/merkle.js');

const SO = '1LockerOrderAaaaaaaaaaaaaaaaaaaaaa';
const SM = '1LockerMatchBbbbbbbbbbbbbbbbbbbbbb';
const T1 = 'ALPHA';
const T2 = 'BRAVO';

function numeric(value){
    const n = Number(value);
    return {
        eq(other){ return n === Number(other); },
        lt(other){ return n < Number(other); },
        valueOf(){ return n; }
    };
}

function makeDb(escrows){
    const addressIds = new Map([[SO, 1], [SM, 2]]);
    const tickIds = new Map([[T1, 1], [T2, 2]]);
    return {
        util: {
            bcnum: numeric,
            bcstr(value){ return String(Number(value)); },
            bcadd(a, b){ return Number(a) + Number(b); },
            bclt(a, b){ return Number(a) < Number(b); }
        },
        async getEscrowLedgerRows(blockIndex){
            return escrows.filter(r => blockIndex === null || r.block_index === blockIndex)
                .map(({ block_index, ...row }) => row);
        },
        async countEscrowLedgerRows(blockIndex){
            return escrows.filter(r => blockIndex === null || r.block_index === blockIndex).length;
        },
        async getEscrowLedgerTotalsByTick(){
            const totals = new Map();
            for(const r of escrows) totals.set(r.tick, (totals.get(r.tick) || 0) + Number(r.amount));
            return Array.from(totals, ([tick, total]) => ({ tick, total: String(total) }));
        },
        async resolveEscrowJournalIndexIds(addresses, ticks){
            const addressList = Array.from(new Set(addresses));
            const tickList = Array.from(new Set(ticks));
            const addrRows = await this.doQuery(
                'SELECT a.id AS id, a.address AS address FROM index_addresses a WHERE a.address IN (' +
                addressList.map(() => '?').join(',') + ')', addressList);
            const tickRows = await this.doQuery(
                'SELECT t.id AS id, t.tick AS tick FROM index_tickers t WHERE t.tick IN (' +
                tickList.map(() => '?').join(',') + ')', tickList);
            return {
                addrIds: new Map(addrRows.map(r => [r.address, r.id])),
                tickIds: new Map(tickRows.map(r => [r.tick, r.id]))
            };
        },
        async getLatestEscrowJournalRows(addresses, ticks){
            return await this.doQuery(
                'SELECT j.address_id AS address_id, j.tick_id AS tick_id, j.locked_amount AS locked_amount ' +
                'FROM escrow_leaf_journal j INNER JOIN (SELECT address_id, tick_id, MAX(id) AS id FROM escrow_leaf_journal)',
                addresses.concat(ticks));
        },
        async insertEscrowJournalRows(rows, blockIndex){
            const args = [];
            for(const row of rows) args.push(row.address_id, row.tick_id, row.locked, blockIndex);
            await this.doQuery(
                'INSERT INTO escrow_leaf_journal (address_id, tick_id, locked_amount, block_index) VALUES ' +
                rows.map(() => '(?, ?, ?, ?)').join(', '), args);
        },
        async doQuery(sql, args){
            if(sql.indexOf('FROM index_addresses a WHERE a.address IN') !== -1)
                return args.map(address => ({ id: addressIds.get(address), address }));
            if(sql.indexOf('FROM index_tickers t WHERE t.tick IN') !== -1)
                return args.map(tick => ({ id: tickIds.get(tick), tick }));
            throw new Error('unexpected passthrough query: ' + sql);
        }
    };
}

function esc(action_index, action_name, address, tick, tick_id, amount, block_index){
    return { action_index, action_name, address, tick, tick_id, amount, block_index };
}

describe('escrow journal shadow dry run: batched lock history @regression', function(){
    it('retains every batched lock so a later release is not replayed before its lock', async function(){
        const db = makeDb([
            esc(10, 'ORDER',       SO, T1, 1, '5',  100),
            esc(11, 'SWAP',        SM, T2, 2, '7',  100),
            esc(12, 'SWAP_EXPIRE', SM, T2, 2, '-7', 101)
        ]);
        const overlay = journalOverlay(db);

        assert.strictEqual(await W.writeEscrowJournal(db, 100), 2);
        assert.strictEqual(await W.writeEscrowJournal(db, 101), 1);
        assert.strictEqual(overlay.rows.length, 3);

        const live = liveSet(overlay.rows);
        assert.deepStrictEqual(Array.from(live), [[SO + '\t' + T1, '5.000000000000000000']]);
    });

    it('drives the dry run, the XCHAIN_ESC leaves and a contract-state proof end to end', async function(){
        const db = makeDb([
            esc(10, 'ORDER',       SO, T1, 1, '5',  100),
            esc(11, 'SWAP',        SM, T2, 2, '7',  100),
            esc(12, 'SWAP_EXPIRE', SM, T2, 2, '-7', 101)
        ]);
        const overlay = journalOverlay(db);

        // The dry run itself: incremental per-block path vs the arming replay.
        const cmp = await compareIncrementalToReplay(db, overlay, [100, 101], 101);
        assert.deepStrictEqual(cmp.mismatches, []);
        assert.strictEqual(cmp.written, 3);
        assert.strictEqual(cmp.replay.size, 1);
        assert.deepStrictEqual(Array.from(cmp.incremental.keys()), Array.from(cmp.replay.keys()));
        assert.strictEqual(cmp.replayWrote, 1);
        // Replica journal rows: after the replay only the one live lock is written.
        assert.strictEqual(overlay.rows.length, 1);
        assert.strictEqual(overlay.rows[0].address, SO);

        // XCHAIN_ESC leaves out of the journal, into an in-memory SMT.
        const leaves = await ESC.liveEscrowLeaves(db);
        assert.strictEqual(leaves.length, 1);
        assert.strictEqual(leaves[0].address, SO);
        const expectedLeaf = M.toHex(M.leafHash(M.canonicalAmount('5')));
        assert.strictEqual(leaves[0].leaf, expectedLeaf);

        const smt = new SC.PersistentSMT(new SC.MemoryNodeStore());
        let root = SC.EMPTY_ROOT_HEX;
        for(const e of leaves)
            root = await smt.update(root, M.escrowKey('BTC', 'regtest', e.address, e.tick), e.leaf);
        assert.notStrictEqual(root, SC.EMPTY_ROOT_HEX);

        // Membership proof for the locked key verifies against the root...
        const lockedKey = M.escrowKey('BTC', 'regtest', SO, T1);
        const proof = await smt.prove(root, lockedKey);
        assert.ok(M.verifyCompressedSmtProof(root, lockedKey, expectedLeaf, proof.compressed));
        // ...and fails for a wrong leaf value and for a wrong root.
        const wrongLeaf = M.toHex(M.leafHash(M.canonicalAmount('6')));
        assert.ok(!M.verifyCompressedSmtProof(root, lockedKey, wrongLeaf, proof.compressed));
        assert.ok(!M.verifyCompressedSmtProof(SC.EMPTY_ROOT_HEX, lockedKey, expectedLeaf, proof.compressed));

        // The released swap lock is absent: a non-membership proof verifies for it.
        const releasedKey = M.escrowKey('BTC', 'regtest', SM, T2);
        const absent = await smt.prove(root, releasedKey);
        assert.ok(M.verifyCompressedSmtProof(root, releasedKey, null, absent.compressed));
    });
});

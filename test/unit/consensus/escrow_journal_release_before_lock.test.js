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
const { journalOverlay, liveSet } = require('../../../bin/shadow-dryrun-escrow-leaf.js');

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
            return escrows.filter(r => r.block_index === blockIndex)
                .map(({ block_index, ...row }) => row);
        },
        async countEscrowLedgerRows(blockIndex){
            return escrows.filter(r => r.block_index === blockIndex).length;
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
});

'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Integration tests: deterministic ordering of simultaneous expirations.
 *
 * Several obligations/items can reach their expiration on the exact same block.
 * The queries that gather them for processing MUST return rows in a stable,
 * instance-independent order. processExpirations iterates that result and emits
 * credits/debits via processAction, each of which allocates a fresh
 * AUTO_INCREMENT action_index. getBlockHashes then orders credits/debits by
 * action_index ASC to derive the per-block ledger hash. If the gather query has
 * no ORDER BY, two honest validators can process same-block expirations in
 * different orders, assign action_index values differently, and derive
 * divergent ledger hashes for the same block — a consensus split.
 *
 * Contract under test: the coinpay gather queries are ordered by
 * co.action_index ASC. We seed obligations whose action_index values are
 * inserted in DESCENDING order (so an unordered query is liable to return them
 * non-ascending) and assert they come back strictly ascending.
 *
 * The sibling expiration query getExpiredItems (orders/swaps/dispensers UNION)
 * carries the same ORDER BY action_index ASC contract; its ordering is already
 * exercised by the order/dispenser expiration paths in scenario 03.
 */

const assert = require('assert');
const {
    createDatabases, resetIndexerDb, closeAll,
} = require('../setup/db-connection');
const { initIndexer, destroyIndexer } = require('../setup/indexer-launcher');

// 30-char addresses (valid P2PKH length, matching the other scenarios)
const PAYER = 'mvBF62avYXhcRZGtQsrE11qByVdDSuMhss';
const PAYEE = 'mnNFBtAigY3EHSCJUZwpyugkphfruNiPHj';

let indexer;

before(async function () {
    this.timeout(30000);
    await createDatabases();
    await resetIndexerDb();
    indexer = await initIndexer();
});

after(async function () {
    await destroyIndexer(indexer);
    await closeAll();
});

describe('07 Deterministic simultaneous-expiry ordering @regression @tier2', function () {
    this.timeout(60000);

    // All obligations share one expiration; the processing block is just past it,
    // so every obligation is simultaneously expirable on the same block.
    const EXPIRATION = 1700000000;
    const BLOCK_TIME = EXPIRATION + 1;
    // action_index values seeded in DESCENDING order on purpose.
    const ACTION_INDEXES = [205, 204, 203, 202, 201];
    const ASCENDING      = [201, 202, 203, 204, 205];

    async function seedPendingObligations(db) {
        for (const ai of ACTION_INDEXES) {
            await db.createCoinpayObligation({
                ACTION_INDEX:  ai,
                PAYER_ADDRESS: PAYER,
                PAYEE_ADDRESS: PAYEE,
                COIN:          'BTC',
                COIN_AMOUNT:   '1000',
                EXPIRATION:    EXPIRATION,
                BLOCK_INDEX:   500,
            });
            // Latest status = pending_coinpay → the obligation is expirable.
            await db.createCoinpayStatus(ai, ai, 'pending_coinpay');
        }
    }

    it('getExpiredCoinpayObligations returns same-block expirations in ascending action_index order', async function () {
        const db = indexer.indexerDb;
        await seedPendingObligations(db);

        const expired = await db.getExpiredCoinpayObligations(BLOCK_TIME);
        const got = expired.map(e => e.action_index);

        assert.deepStrictEqual(
            got,
            ASCENDING,
            'expired coinpay obligations must be returned in ascending action_index order'
        );
    });

    it('getPendingCoinpayObligationsByOrder returns obligations in ascending action_index order', async function () {
        const db = indexer.indexerDb;
        // Obligations from the previous test persist (no reset between its in one
        // describe). Re-seed defensively in case of isolated runs.
        await seedPendingObligations(db);

        // Link every obligation to the same originating order via an order_match
        // whose action_index equals the obligation action_index (om.action_index
        // = co.action_index) and whose get_action_index is the shared order.
        const ORDER_ACTION_INDEX = 100;
        const MATCH_ACTION_INDEX = 150;
        for (const ai of ACTION_INDEXES) {
            await db.createOrderMatch(
                {
                    ACTION_INDEX:      ai,
                    STATUS:            'open',
                    MATCH_GIVE_AMOUNT: '1',
                    MATCH_GET_AMOUNT:  '1',
                    SETTLEMENT_TYPE:   'instant',
                },
                {   // the "order" → supplies get_action_index
                    ACTION_INDEX: ORDER_ACTION_INDEX,
                    GIVE_COIN:    'BTC',
                    GIVE_TICK:    'ALPHA',
                    GET_COIN:     'BTC',
                    GET_TICK:     'BETA',
                },
                {   // the "match" → supplies give_action_index
                    ACTION_INDEX: MATCH_ACTION_INDEX,
                }
            );
        }

        const pending = await db.getPendingCoinpayObligationsByOrder(ORDER_ACTION_INDEX);

        assert.deepStrictEqual(
            pending,
            ASCENDING,
            'pending coinpay obligations for an order must be returned in ascending action_index order'
        );
    });
});

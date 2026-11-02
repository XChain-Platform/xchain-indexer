/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * test/unit/db/text_width/refused_row_fit.test.js
 *
 * A refused action still writes its row, with its wire text as carried. Text longer than
 * its VARCHAR column, or a supplementary-plane character bound to a utf8mb3 column, failed
 * that write under the strict sql_mode and the block retried forever on every indexer. Each
 * writer now fits what a refused row binds; a value that already fits binds unchanged.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { anchorActionRow } = require('../../../../src/db/anchors/anchor_action_row.js');
const { fitColumnText }   = require('../../../../src/db/column_text.js');
const { EMOJI, FFFD, strictDb } = require('./helpers/strict_db.js');

const INTERNERS = [['createCoin', 'index_coins'], ['createFiat', 'index_fiats']];

// Each case: the writer, the row data, and the stored value of every checked column.
const WRITER_CASES = [
    { name: 'a refused XCALL v0 (broadcast, not a VM emission)', write: 'createCrossChainCallRequest', table: 'xcalls',
      data: { ACTION_INDEX: 9, BLOCK_INDEX: 5, STATUS: 'invalid: XCALL v0 must originate from VM emission',
              CALL_ID: 'A'.repeat(81), TARGET_CHAIN: 'DOGE' + EMOJI, METHOD: 'm'.repeat(65), CALLBACK_METHOD: EMOJI.repeat(65) },
      expect: { call_id: 'a'.repeat(80), target_chain: 'DOGE' + FFFD, method: 'm'.repeat(64), callback_method: EMOJI.repeat(64) } },
    { name: 'a valid XCALL v0', write: 'createCrossChainCallRequest', table: 'xcalls',
      data: { ACTION_INDEX: 9, BLOCK_INDEX: 5, STATUS: 'valid', CALL_ID: 'AB'.repeat(32), TARGET_CHAIN: 'LTC',
              METHOD: 'transfer', CALLBACK_METHOD: 'onResult' },
      expect: { call_id: 'ab'.repeat(32), target_chain: 'LTC', method: 'transfer', callback_method: 'onResult' } },
    { name: 'a MESSAGE refused for its COIN', write: 'createMessage', table: 'messages',
      data: { ACTION: 'MESSAGE', ACTION_INDEX: 9, STATUS: 'invalid: COIN (value)', COIN: 'XXXXXXXX' },
      expect: { coin: 'XXXX' } },
    { name: 'a refused ISSUE', write: 'createIssue', table: 'issues',
      data: { ACTION: 'ISSUE', ACTION_INDEX: 9, STATUS: 'invalid: MIN_DEPTH (format)', TICK: 'T', DECIMALS: '0001',
              CALLBACK_BLOCK: '0'.repeat(15) + '1', MINT_START_BLOCK: '0'.repeat(19) + '1', MINT_STOP_BLOCK: '9'.repeat(16),
              BRIDGE_CHAINS: 'LTC,'.repeat(63), MIN_DEPTH: 'x'.repeat(16), LOCK_BRIDGE: '11' },
      expect: { decimals: '00', callback_block: '0'.repeat(15), mint_start_block: '0'.repeat(15),
                mint_stop_block: '9'.repeat(15), bridge_chains: 'LTC,'.repeat(62) + 'LT', min_depth: 'x'.repeat(15),
                lock_bridge: '1' } },
    { name: 'a valid ISSUE', write: 'createIssue', table: 'issues',
      data: { ACTION: 'ISSUE', ACTION_INDEX: 9, STATUS: 'valid', TICK: 'T', DECIMALS: '8', MINT_START_BLOCK: '100',
              BRIDGE_CHAINS: 'LTC,DOGE', MIN_DEPTH: '6', LOCK_BRIDGE: '1' },
      expect: { decimals: '8', mint_start_block: '100', bridge_chains: 'LTC,DOGE', min_depth: '6', lock_bridge: '1' } },
    { name: 'a refused PRICE v1', write: 'createPrice', table: 'prices',
      data: { ACTION: 'PRICE', ACTION_INDEX: 9, VERSION: 1, STATUS: 'invalid: VALUE (format)',
              V1_VALUE: '1'.repeat(300), V1_FEE: 'f'.repeat(251) },
      expect: { value: '1'.repeat(250), fee: 'f'.repeat(250) } },
    { name: 'a refused BET feed', write: 'createBetFeed', table: 'bet_feeds',
      data: { ACTION: 'BET', ACTION_INDEX: 9, STATUS: 'invalid: LABEL (length)', FEED_STATUS: 'invalid',
              LABEL: 'L'.repeat(251), OUTCOMES: 'yes,' + ' '.repeat(1100) + 'no', FEE: '000000000005' },
      expect: { label: 'L'.repeat(250), outcomes: ('yes,' + ' '.repeat(1100)).substring(0, 1100), fee: '00000000000' } }
];

async function internsWithReplacement(method, table){
    const { db, interned } = strictDb();
    assert.notStrictEqual(await db[method]('B' + EMOJI), null);
    assert.deepStrictEqual([...interned[table].keys()], ['B' + FFFD]);
}

async function overLongStaysNull(method, table){
    const { db, interned } = strictDb();
    assert.strictEqual(await db[method]('C'.repeat(300)), null);
    assert.deepStrictEqual([...interned[table].keys()], ['C'.repeat(250)]);
    assert.notStrictEqual(await db[method]('BTC'), null);
}

async function storesWithinColumns(c){
    const { db, inserts } = strictDb();
    await db[c.write](Object.assign({}, c.data));
    const row = inserts[c.table];
    assert.ok(row, 'no INSERT INTO ' + c.table);
    for(const column of Object.keys(c.expect))
        assert.strictEqual(row[column], c.expect[column], c.table + '.' + column);
}

afterEach(function () {
    sinon.restore();
});

describe('Column text fit on refused rows (db writers) @regression', function () {
    it('fitColumnText returns a fitting value as given and clips or maps only what the column refuses', function () {
        assert.strictEqual(fitColumnText(null, 4, true), null);
        assert.strictEqual(fitColumnText(7, 4, false), 7);
        assert.strictEqual(fitColumnText('BTC', 4, true), 'BTC');
        assert.strictEqual(fitColumnText('XXXXX', 4, false), 'XXXX');
        assert.strictEqual(fitColumnText(EMOJI + 'A', 4, true), FFFD + 'A');
        assert.strictEqual(fitColumnText(EMOJI.repeat(5), 4, false), EMOJI.repeat(4));
    });

    for(const [method, table] of INTERNERS){
        it(method + ' interns a value carrying a 4-byte character as U+FFFD instead of throwing',
            () => internsWithReplacement(method, table));
        it(method + ' still resolves an over-long value to NULL, as INSERT IGNORE always did',
            () => overLongStaysNull(method, table));
    }

    it('getOrCreatePubkeyId interns a refused SIGNING_PUBKEY with a 4-byte character as U+FFFD', async function () {
        const { db, interned } = strictDb();
        assert.notStrictEqual(await db.getOrCreatePubkeyId('ab' + EMOJI), null);
        assert.deepStrictEqual([...interned.index_pubkeys.keys()], ['ab' + FFFD]);
    });

    it('getPubkeyId answers no row for a key utf8mb3 cannot hold, without a query', async function () {
        const { db } = strictDb();
        assert.strictEqual(await db.getPubkeyId(EMOJI), null);
        assert.strictEqual(db.doQuery.callCount, 0);
    });

    it('anchorActionRow maps a 4-byte CHAIN inside its bound to U+FFFD and keeps NULL past it', function () {
        assert.strictEqual(anchorActionRow({ CHAIN: EMOJI }, 1).args[2], FFFD);
        assert.strictEqual(anchorActionRow({ CHAIN: EMOJI.repeat(6) }, 1).args[2], null);
        assert.strictEqual(anchorActionRow({ CHAIN: 'BTC' }, 1).args[2], 'BTC');
    });

    for(const c of WRITER_CASES)
        it('stores ' + c.name + ' within its columns', () => storesWithinColumns(c));
});

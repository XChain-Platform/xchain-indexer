/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const { getTestConfig } = require('../../../fixtures/config');
const Utility = require('../../../../src/utility');
const Database = require('../../../../src/db');

const rows = [
  { action_index: 10, list_action_index: null, type: 2, status: 'valid', block_index: 10 },
  { action_index: 11, list_action_index: 10, type: 2, status: 'valid', block_index: 110 },
  { action_index: 12, list_action_index: null, type: 2, status: 'valid', block_index: 12 },
  { action_index: 20, list_action_index: null, type: 3, status: 'valid', block_index: 20 },
  { action_index: 30, list_action_index: null, type: 1, status: 'valid', block_index: 30 },
  { action_index: 32, list_action_index: null, type: 1, status: 'valid', block_index: 32 },
  { action_index: 40, list_action_index: null, type: 3, status: 'valid', block_index: 40 },
  { action_index: 50, list_action_index: null, type: 3, status: 'invalid: TYPE (unknown)', block_index: 50 },
  { action_index: 60, list_action_index: null, type: 3, status: 'valid', block_index: 60 },
  { action_index: 61, list_action_index: 60, type: 3, status: 'valid', block_index: 61 },
  { action_index: 70, list_action_index: null, type: 3, status: 'valid', block_index: 70 }
];

const items = {
  10: ['b', 'shared'],
  11: ['future', 'shared'],
  12: ['A', 'shared'],
  20: [10, 12],
  30: ['zeta', 'ALPHA'],
  32: ['beta', 'ALPHA'],
  40: [30, 32],
  60: [10],
  61: [10, 12],
  // Mixed member types, which admission refuses: only row order can pick the member type.
  70: [12, 32]
};

function makeDb() {
  const config = getTestConfig();
  const util = new Utility();
  sinon.stub(util, 'logError');
  const db = new Database(null, null, null, null, null, { config, util });
  const rowFor = (index) => rows.find((row) => String(row.action_index) === String(index));

  sinon.stub(db, 'doQuery').callsFake(async (query, args) => {
    const normalized = query.replace(/\s+/g, ' ');
    if (/SELECT l\.type FROM lists l INNER JOIN index_statuses/i.test(normalized)) {
      const row = rowFor(args[0]);
      return row && row.status === 'valid' ? [{ type: row.type }] : [];
    }
    if (/SELECT type FROM lists WHERE action_index=/i.test(normalized)) {
      const row = rowFor(args[0]);
      return row ? [{ type: row.type }] : [];
    }
    if (/SELECT list_action_index FROM lists WHERE action_index=/i.test(normalized)) {
      const row = rowFor(args[0]);
      return row ? [{ list_action_index: row.list_action_index }] : [];
    }
    if (/SELECT l\.list_action_index FROM lists l INNER JOIN actions/i.test(normalized)) {
      const row = rowFor(args[0]);
      return row && row.block_index > Number(args[1])
        ? [{ list_action_index: row.list_action_index }]
        : [];
    }
    if (/SELECT l\.action_index FROM lists l INNER JOIN index_statuses/i.test(normalized) &&
        /l\.list_action_index IS NULL/i.test(normalized)) {
      const row = rowFor(args[0]);
      return row && row.list_action_index === null && Number(row.type) === 3 && row.status === 'valid'
        ? [{ action_index: row.action_index }]
        : [];
    }
    if (/SELECT item_id AS action_index FROM list_items/i.test(normalized)) {
      // Model an engine with no row-order guarantee: an unordered read gets reverse order.
      const memberRoots = [...(items[String(args[0])] || [])];
      if (/ORDER BY/i.test(normalized)) memberRoots.sort((a, b) => Number(a) - Number(b));
      else memberRoots.reverse();
      return memberRoots.map((action_index) => ({ action_index }));
    }
    if (/FROM lists l INNER JOIN index_statuses/i.test(normalized)) {
      const children = rows
        .filter((row) => String(row.list_action_index) === String(args[0]))
        .filter((row) => row.status === 'valid')
        .filter((row) => args.length < 2 || row.block_index <= Number(args[1]))
        .sort((left, right) => right.action_index - left.action_index);
      return children.map((row) => ({ action_index: row.action_index, status: row.status }));
    }
    if (/FROM list_items l/i.test(normalized)) {
      return (items[String(args[0])] || []).map((item) => ({ item }));
    }
    return [];
  });
  return db;
}

afterEach(function () { sinon.restore(); });

describe('database union list resolution @regression @tier1', function () {
  it('returns the member type and validates an address union as type 2', async function () {
    const db = makeDb();
    assert.strictEqual(await db.getListType(20, 100), 2);
    assert.strictEqual(await db.isValidList(20, 2, 100), true);
  });

  it('merges distinct address members in UTF-8 byte order', async function () {
    const db = makeDb();
    assert.deepStrictEqual(await db.getList(20, 200), ['A', 'future', 'shared']);
  });

  it('reads member roots from the union head', async function () {
    const db = makeDb();
    assert.deepStrictEqual(await db.getList(60, 200), ['A', 'future', 'shared']);
  });

  it('bounds every member at the requested block', async function () {
    const db = makeDb();
    assert.deepStrictEqual(await db.getListAtBlock(20, 100), ['A', 'b', 'shared']);
  });

  it('resolves tick unions to ticks', async function () {
    const db = makeDb();
    assert.strictEqual(await db.getListType(40, 100), 1);
    assert.deepStrictEqual(await db.getList(40, 100), ['ALPHA', 'beta', 'zeta']);
  });

  it('resolves a valid union without a block context', async function () {
    const db = makeDb();
    assert.deepStrictEqual(await db.getList(20), ['A', 'b', 'shared']);
  });

  it('preserves the legacy answers for an invalid stored type-3 row', async function () {
    const db = makeDb();
    assert.strictEqual(await db.getListType(50), 3);
    assert.deepStrictEqual(await db.getList(50), []);
    assert.strictEqual(await db.getListType(50, 100), false);
    assert.strictEqual(await db.getList(50, 100), null);
  });

  it('takes the union member type from the lowest member root, whatever the row order', async function () {
    const db = makeDb();
    assert.strictEqual(await db.getListType(70, 100), 2);
  });
});

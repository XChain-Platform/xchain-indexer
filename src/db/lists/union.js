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
 **********************************************************************
 *
 * Union merge of list membership arrays.
 *
 ********************************************************************/

'use strict';

// Distinct items across every member, ascending by UTF-8 byte order (the order COLLATE
// utf8_bin gives). A member that is not an array throws a TypeError so the caller decides
// what an unreadable member means. Returns a new array and leaves the input untouched.
function mergeUnionMembers(lists) {
  const distinct = new Set();
  for (const members of lists) {
    if (!Array.isArray(members)) {
      throw new TypeError('union member must be an array');
    }
    for (const item of members) distinct.add(item);
  }
  return [...distinct]
    .map((item) => ({ item, bytes: Buffer.from(item, 'utf8') }))
    .sort((a, b) => Buffer.compare(a.bytes, b.bytes))
    .map((entry) => entry.item);
}

async function getUnionMemberRoots(db, actionIndex) {
  const rows = await db.doQuery(
    `SELECT item_id AS action_index
     FROM list_items
     WHERE action_index=?`,
    [actionIndex]
  );
  return rows.map((row) => row.action_index);
}

async function getUnionResolution(db, actionIndex, storedType, blockIndex) {
  if (Number(storedType) !== 3) return null;

  const rootIndex = await db.getListRootIndex(actionIndex);
  const roots = await db.doQuery(
    `SELECT l.action_index
     FROM lists l
     INNER JOIN index_statuses s ON (s.id=l.status_id)
     WHERE l.action_index=?
       AND l.list_action_index IS NULL
       AND l.type=3
       AND s.status='valid'
     LIMIT 1`,
    [rootIndex]
  );
  if (roots.length === 0) return null;

  const memberRoots = await getUnionMemberRoots(db, rootIndex);
  if (memberRoots.length === 0) return null;
  const getStoredType = db.getListStoredType;
  const memberType = await getStoredType.call(db, memberRoots[0], blockIndex);
  if (memberType !== 1 && memberType !== 2) return null;
  return { rootIndex, memberType };
}

async function readUnionMembers(db, headIndex, blockIndex, atBlock) {
  const memberRoots = await getUnionMemberRoots(db, headIndex);
  const lists = [];
  for (const memberRoot of memberRoots) {
    lists.push(atBlock
      ? await db.getListAtBlock(memberRoot, blockIndex)
      : await db.getList(memberRoot, blockIndex));
  }
  return mergeUnionMembers(lists);
}

module.exports = { mergeUnionMembers, getUnionResolution, readUnionMembers };

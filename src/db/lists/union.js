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

module.exports = { mergeUnionMembers };

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

const assert = require('assert');

const { mergeUnionMembers } = require('../../../../src/db/lists/union');

describe('mergeUnionMembers', () => {
  it('dedupes items across members', () => {
    assert.deepStrictEqual(mergeUnionMembers([['a', 'b'], ['b', 'c'], ['a']]), ['a', 'b', 'c']);
  });

  it('orders by UTF-8 bytes, uppercase before lowercase', () => {
    assert.deepStrictEqual(mergeUnionMembers([['b', 'a'], ['a', 'B']]), ['B', 'a', 'b']);
  });

  it('places a multi-byte item after every ASCII item', () => {
    assert.deepStrictEqual(mergeUnionMembers([['é', 'z'], ['a', 'Z']]), ['Z', 'a', 'z', 'é']);
  });

  it('returns an empty array for an empty union', () => {
    assert.deepStrictEqual(mergeUnionMembers([]), []);
    assert.deepStrictEqual(mergeUnionMembers([[], []]), []);
  });

  it('throws a TypeError for a member that is not an array', () => {
    assert.throws(() => mergeUnionMembers([['a'], null]), TypeError);
    assert.throws(() => mergeUnionMembers(['abc']), TypeError);
  });

  it('returns a new array and leaves the input unmutated', () => {
    const input = [['b', 'a'], ['a', 'B']];
    const out = mergeUnionMembers(input);
    assert.deepStrictEqual(input, [['b', 'a'], ['a', 'B']]);
    assert.notStrictEqual(out, input[0]);
    assert.notStrictEqual(out, input[1]);
  });
});

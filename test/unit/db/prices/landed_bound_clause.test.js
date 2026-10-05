// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');

const { landedBoundClause } = require('../../../../src/db/prices/landed_bound.js');

describe('landedBoundClause()', function () {
    it('returns no clause when the landed bound is inactive', function () {
        assert.strictEqual(landedBoundClause(false, false), '');
    });

    it('returns no clause when inactive even if strict is truthy', function () {
        assert.strictEqual(landedBoundClause(false, true), '');
    });

    it('returns the inclusive clause when active and not strict', function () {
        assert.strictEqual(landedBoundClause(true, false),
            ' AND batch_block_time > 0 AND batch_block_time <= ?');
    });

    it('returns the exclusive clause when active and strict', function () {
        assert.strictEqual(landedBoundClause(true, true),
            ' AND batch_block_time > 0 AND batch_block_time < ?');
    });
});

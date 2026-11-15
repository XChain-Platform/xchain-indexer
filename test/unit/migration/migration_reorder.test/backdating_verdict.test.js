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
 ********************************************************************/

'use strict';

const assert = require('assert');
const { backdatingVerdict } = require('../../../../src/db/database/migration_reorder.js');

const split = (raw) => String(raw).split(';').map(s => s.trim()).filter(Boolean);

describe('shared migration backdating verdict @regression', function () {
    it('distinguishes overlapping, disjoint and unreadable jumped migrations', function () {
        const files = {
            '2026-02-01-overlap.sql': 'ALTER TABLE balances ADD COLUMN b INT',
            '2026-02-02-disjoint.sql': 'ALTER TABLE tokens ADD COLUMN b INT',
        };
        const analyze = (names, readApplied = name => files[name]) => backdatingVerdict({
            file: '2026-01-01-pending.sql', raw: 'ALTER TABLE balances ADD COLUMN a INT',
            appliedNames: names, readApplied, split,
        });
        const overlap = analyze(['2026-02-01-overlap.sql']);
        assert.strictEqual(overlap.frontier, '2026-02-01-overlap.sql');
        assert.strictEqual(overlap.verdict.divergent, true);
        assert.deepStrictEqual(overlap.verdict.shared.map(row => row.file), ['2026-02-01-overlap.sql']);
        assert.strictEqual(analyze(['2026-02-02-disjoint.sql']).verdict.divergent, false);
        const opaque = analyze(['2026-02-03-missing.sql'], () => { throw new Error('missing'); });
        assert.strictEqual(opaque.verdict.divergent, true);
        assert.deepStrictEqual(opaque.verdict.opaque.map(row => row.file), ['2026-02-03-missing.sql']);
    });

    it('returns null when the pending file is not behind the applied frontier', function () {
        assert.strictEqual(backdatingVerdict({ file: '2026-03-01-new.sql', raw: '',
            appliedNames: ['2026-02-01-old.sql'], readApplied: () => '', split }), null);
    });
});

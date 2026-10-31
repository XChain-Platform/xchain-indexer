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
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Schema migration runner: same-date filename apply order.
 *
 * The runner applies files in readdirSync().sort() order, and '-' sorts before '.', so a
 * follow-up named <base>-<suffix>.sql applies BEFORE <base>.sql. This pins that no committed
 * follow-up extends its base's name that way, so the authored pairing is the apply order.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const MIG_DIR = path.join(__dirname, '..', '..', '..', 'src', 'sql', 'migrations');

// Every [base, extension] stem pair where the extension file sorts, and so applies, first.
function invertedPrefixPairs(files) {
    const sorted = files.filter(f => f.endsWith('.sql')).sort();
    const stems = sorted.map(f => f.slice(0, -4));
    const out = [];
    stems.forEach((base, bi) => {
        stems.forEach((ext, ei) => {
            if (ext !== base && ext.startsWith(base) && ei < bi) out.push([base, ext]);
        });
    });
    return out;
}

// One existing pair, exempt because its two files modify disjoint columns, so either order
// yields the same schema, and renaming an applied migration needs a ledger rename. Add no more.
const GRANDFATHERED = [
    ['2026-09-02-utf8mb4-raw-wire-fields', '2026-09-02-utf8mb4-raw-wire-fields-not-null'],
];

const key = (pair) => pair.join(' <- ');

describe('committed migrations apply in their authored same-date order @regression @tier1', function () {
    const files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith('.sql'));

    it('invertedPrefixPairs finds a hyphen-suffixed follow-up that sorts before its base', function () {
        assert.deepStrictEqual(
            invertedPrefixPairs(['2026-01-01-a.sql', '2026-01-01-a-b.sql', '2026-01-01-c.sql']),
            [['2026-01-01-a', '2026-01-01-a-b']]);
        assert.deepStrictEqual(invertedPrefixPairs(['2026-01-01-a.sql', '2026-01-01-ab.sql', '2026-01-02-a-b.sql']), []);
    });

    it('no migration filename extends a same-date base with a suffix that applies first', function () {
        const exempt = new Set(GRANDFATHERED.map(key));
        const offenders = invertedPrefixPairs(files).filter(p => !exempt.has(key(p)));
        assert.deepStrictEqual(offenders, [],
            'apply order is readdirSync().sort(), so <base>-<suffix>.sql runs BEFORE <base>.sql: ' +
            offenders.map(([b, e]) => e + '.sql applies before ' + b + '.sql').join('; ') +
            '. Give the follow-up a slug that does not extend the base name, or a later date.');
    });

    it('every grandfathered pair still exists and still inverts, so no exemption is stale', function () {
        const found = new Set(invertedPrefixPairs(files).map(key));
        for (const pair of GRANDFATHERED) {
            assert.ok(found.has(key(pair)), 'stale exemption, remove it: ' + key(pair));
        }
    });
});

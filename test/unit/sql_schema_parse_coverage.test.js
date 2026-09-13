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
 * SQL schema parse-coverage contract test.
 *
 * The on-startup column-drift reconciler (db.js verifyTables -> alterTableForDrift)
 * keeps existing databases in sync with the canonical src/sql/*.sql sources by
 * ADD COLUMN-ing any column declared in the source but missing live. It relies on
 * parseExpectedColumns(), whose regex only recognizes a `CREATE TABLE ... ) ENGINE`
 * definition. If a source file can't be parsed (e.g. a missing ENGINE clause), the
 * reconciler SILENTLY skips that whole table; this is exactly how cross_chain_matches
 * shipped without its Phase B partial-fill columns on databases created before the
 * release.
 *
 * This locks the invariant: every table source in src/sql/ MUST be parseable into
 * at least one column, so column-drift reconciliation can never be silently disabled
 * for a table again. Adding a new src/sql/<table>.sql that lacks an ENGINE clause
 * (or is otherwise unparseable) fails here, in CI, instead of in production.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../src/db');

// parseExpectedColumns + stripSqlLineComments are pure string functions (no DB,
// config, or util needed. Bind them onto a bare object so we can call them in isolation.
const parser = {
    stripSqlLineComments: Database.prototype.stripSqlLineComments,
    parseExpectedColumns: Database.prototype.parseExpectedColumns,
};
const parse = (sql) => parser.parseExpectedColumns(sql);

const SQL_DIR = path.join(__dirname, '..', '..', 'src', 'sql');
const sqlFiles = fs.readdirSync(SQL_DIR).filter(f => f.endsWith('.sql'));

describe('src/sql schema parse-coverage @regression @tier1', function () {

    it('finds at least one table source (sanity)', function () {
        assert.ok(sqlFiles.length > 0, 'no .sql files found in ' + SQL_DIR);
    });

    sqlFiles.forEach(function (file) {
        describe(file, function () {
            const data = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
            const cols = parse(data);

            it('is parseable by the drift reconciler (non-null)', function () {
                assert.ok(cols !== null,
                    file + ' could not be parsed by parseExpectedColumns; the column-drift ' +
                    'reconciler would SILENTLY skip this table. Ensure the CREATE TABLE ends with ' +
                    'a `) ENGINE=...` clause (matching the other src/sql files).');
            });

            it('yields at least one column', function () {
                assert.ok(Array.isArray(cols) && cols.length > 0,
                    file + ' parsed to zero columns; drift reconciliation would be a no-op.');
            });

            it('every parsed column has a name and a definition', function () {
                for (const c of (cols || [])) {
                    assert.ok(c.name && typeof c.name === 'string', file + ': a column has no name');
                    assert.ok(c.definition && /\S/.test(c.definition),
                        file + ': column ' + c.name + ' has no usable definition (needed verbatim for ADD COLUMN)');
                }
            });
        });
    });
});

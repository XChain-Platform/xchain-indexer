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
 * SQL quote walkers model MariaDB/MySQL backslash escapes.
 *
 * MariaDB/MySQL honour `\<char>` inside `'` and `"` string literals whenever
 * sql_mode omits NO_BACKSLASH_ESCAPES, which nothing in this tree sets. The four
 * walkers used to treat a doubled quote as the ONLY escape, so a `\'` closed the
 * span early, the literal's real closing quote re-opened it, and the following
 * `;` plus everything up to the next quote merged into one chunk. A `DROP TABLE`
 * then rode inside a chunk whose first keyword was INSERT, where the ^-anchored
 * keyword checks in _destructiveAutoStatement never saw it and the file scored
 * auto-eligible.
 *
 * These assertions fail against the pre-fix walkers: reverting the
 * opensBackslashEscape branch in src/db.js turns the split counts back to 1 and
 * the destructive offender back to null.
 *
 ********************************************************************/

const assert = require('assert');

const Database = require('../../src/db');

// Same binding technique migration-runner.test.js uses: the walkers are pure, so
// bind them to the prototype rather than standing up a live Database.
const stripComments = Database.prototype.stripSqlLineComments.bind({});
const destructiveOf = Database.prototype._destructiveAutoStatement.bind(Database.prototype);
const statementsOf  = (raw) => Database.prototype.splitSqlStatements.call(Database.prototype, raw);
const isIdRepair    = Database.prototype._isIdRepairUpdate.bind(Database.prototype);

// Build the literal backslash out of a charCode so no layer of source escaping can
// quietly turn `\'` into `\\'` and make the test assert a different string than the
// one the failure needs.
const BS = String.fromCharCode(92);

describe('SQL quote walkers honour backslash escapes @regression @tier1', function () {

    it('splits INSERT-with-\\\' then DROP into two statements, not one', function () {
        const raw = "INSERT INTO index_memos (memo) VALUES ('it" + BS + "'s fine');\n" +
                    'DROP TABLE balances;\n';
        const stmts = statementsOf(raw);
        assert.strictEqual(stmts.length, 2,
            'the server runs two statements here; a desynced walker returns one merged chunk');
        assert.ok(/^INSERT\b/i.test(stmts[0]), 'first statement is the INSERT');
        assert.ok(/^DROP\s+TABLE\b/i.test(stmts[1]), 'second statement is the DROP');
    });

    it('flags the DROP hidden behind a backslash-escaped quote as destructive DDL', function () {
        const raw = "INSERT INTO index_memos (memo) VALUES ('it" + BS + "'s fine');\n" +
                    'DROP TABLE balances;\n';
        const offender = destructiveOf(statementsOf(raw));
        assert.ok(offender, 'a mode=auto file carrying this DROP must not score auto-eligible');
        assert.ok(/^DROP\s+TABLE\b/i.test(offender), 'the offender is the DROP, got: ' + offender);
    });

    it('applies the same rule inside a double-quoted literal', function () {
        const raw = 'INSERT INTO index_memos (memo) VALUES ("it' + BS + '"s fine");\n' +
                    'DROP TABLE balances;\n';
        const stmts = statementsOf(raw);
        assert.strictEqual(stmts.length, 2);
        assert.ok(/^DROP\s+TABLE\b/i.test(destructiveOf(stmts) || ''));
    });

    it('does NOT treat a backslash inside a backtick identifier as an escape', function () {
        // Backslash is a literal character inside an identifier quote, so the
        // backtick closes the span and the `;` terminates the statement.
        const raw = 'ALTER TABLE `t' + BS + '` ADD COLUMN a INT;\nDROP TABLE balances;\n';
        const stmts = statementsOf(raw);
        assert.strictEqual(stmts.length, 2,
            'consuming `\\`` would swallow the terminator and desync the other way');
        assert.ok(/^DROP\s+TABLE\b/i.test(stmts[1]));
    });

    it('still treats a doubled quote as an escape', function () {
        const raw = "INSERT INTO t (a) VALUES ('it''s fine');\nDROP TABLE balances;\n";
        const stmts = statementsOf(raw);
        assert.strictEqual(stmts.length, 2);
        assert.ok(/^DROP\s+TABLE\b/i.test(stmts[1]));
    });

    it('preserves a -- sequence inside a backslash-escaped literal instead of stripping it', function () {
        const raw = "INSERT INTO t (a) VALUES ('x" + BS + "' -- y');\nSELECT 1;\n";
        const out = stripComments(raw);
        assert.ok(out.includes('-- y'),
            'the `-- y` sits inside the literal; stripping it corrupts the statement');
        assert.ok(out.includes('SELECT 1'));
    });

    it('preserves a # inside a backslash-escaped literal', function () {
        const raw = "INSERT INTO t (a) VALUES ('x" + BS + "' # y');\nSELECT 1;\n";
        assert.ok(stripComments(raw).includes('# y'));
    });

    it('does not let a backslash-escaped quote hide a # from hasUnquotedHash', function () {
        // The `#` here is OUTSIDE the literal once the escape is modelled, so the
        // classifier must refuse the statement rather than read past a comment.
        const raw = "UPDATE cfg SET v = '" + BS + "'# hidden\n' WHERE id = 0;\n";
        assert.ok(destructiveOf(statementsOf(raw)), 'a visible # makes the statement non-auto-eligible');
    });

    it('does not throw or hang on input ending in a lone backslash inside an open literal', function () {
        const raw = "INSERT INTO t (a) VALUES ('x" + BS;
        assert.doesNotThrow(() => statementsOf(raw));
        assert.doesNotThrow(() => stripComments(raw));
        assert.doesNotThrow(() => destructiveOf([raw]));
    });

    it('_isIdRepairUpdate keeps recognising the committed repair shape', function () {
        const repair = 'UPDATE `mirror` SET id = (SELECT COALESCE(MAX(t.id), 0) + 1 FROM (SELECT id FROM `mirror`) t) WHERE id = 0';
        assert.strictEqual(isIdRepair(repair), true);
    });

    it('_isIdRepairUpdate is not fooled by a backslash-escaped quote in the subquery', function () {
        // A `\'` inside the subquery must not close the span early: that unbalances
        // the paren scan and rejects a legitimate repair (or accepts a bogus one).
        const repair = 'UPDATE `mirror` SET id = (SELECT COALESCE(MAX(id), 0) + 1 FROM `mirror` WHERE tag = ' +
                       "'it" + BS + "'s') WHERE id = 0";
        assert.strictEqual(isIdRepair(repair), true);
    });
});

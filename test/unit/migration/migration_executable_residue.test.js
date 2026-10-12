/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Migration immutability in CI: every pinned migration keeps its executable residue,
 * and its whole-file hash changes only under a reviewed rebaseline. The runtime guard
 * (checkAppliedChecksum) sees an in-place edit only once a deployed ledger disagrees;
 * this sees it at the commit. Pin new files with bin/lib/migration_residue_pin.js --add.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const pin = require('../../../bin/lib/migration_residue_pin.js');
const { MIGRATION_CHECKSUM_REBASELINES } = require('../../../src/db/migration/checksum_rebaselines.js');

describe('migration executable-residue pin @regression @tier1', function () {
    const fixture = JSON.parse(fs.readFileSync(pin.FIXTURE, 'utf8'));

    it('every pinned migration on disk still matches its pin', function () {
        const bad = pin.findViolations({ files: pin.readTree(), fixture, rebaselines: pin.readRebaselines() });
        assert.deepStrictEqual(bad.map((v) => v.kind + ': ' + v.message), []);
    });

    it('pins at least the migrations the rebaseline table names', function () {
        for (const file of Object.keys(pin.readRebaselines())) assert.ok(fixture[file], file + ' is not pinned');
    });

    it('the data read equals the module export', function () {
        assert.deepStrictEqual(pin.readRebaselines(), JSON.parse(JSON.stringify(MIGRATION_CHECKSUM_REBASELINES)));
    });
});

describe('migration executable-residue pin: the guard bites @regression @tier1', function () {
    const FILE = '2099-01-01-sample.sql';
    const RAW  = '-- xchain:migration mode=auto\nALTER TABLE t ADD COLUMN IF NOT EXISTS c INT;\n';
    const fixture = { [FILE]: pin.pinOf(RAW) };
    const kinds = (files, rebaselines) => pin.findViolations({ files, fixture, rebaselines: rebaselines || {} }).map((v) => v.kind);

    it('an untouched file passes', function () {
        assert.deepStrictEqual(kinds({ [FILE]: RAW }), []);
    });

    it('an added statement is a residue violation, even with a rebaseline', function () {
        const edited = RAW + 'SELECT 1;\n';
        assert.deepStrictEqual(kinds({ [FILE]: edited }), ['residue']);
        const heal = { [FILE]: { from: pin.pinOf(RAW).sha256, to: pin.pinOf(edited).sha256 } };
        assert.deepStrictEqual(kinds({ [FILE]: edited }, heal), ['residue']);
    });

    it('a comment-only edit is a content violation unless a rebaseline heals exactly that pair', function () {
        const edited = '-- a note\n' + RAW;
        assert.deepStrictEqual(kinds({ [FILE]: edited }), ['content']);
        assert.deepStrictEqual(kinds({ [FILE]: edited }, { [FILE]: { from: pin.pinOf(RAW).sha256, to: pin.pinOf(edited).sha256 } }), []);
        assert.deepStrictEqual(kinds({ [FILE]: edited }, { [FILE]: { from: 'f'.repeat(64), to: pin.pinOf(edited).sha256 } }), ['content']);
    });

    it('a removed pinned file is missing, and a new unpinned file is free', function () {
        assert.deepStrictEqual(kinds({}), ['missing']);
        assert.deepStrictEqual(kinds({ [FILE]: RAW, '2099-01-02-new.sql': 'SELECT 1;' }), []);
    });

    it('a file committed at the base and left unpinned is flagged', function () {
        const NEW = '2099-01-02-new.sql';
        const files = { [FILE]: RAW, [NEW]: 'SELECT 1;' };
        const bad = pin.findViolations({ files, fixture, rebaselines: {}, committed: [FILE, NEW] });
        assert.deepStrictEqual(bad.map((v) => v.kind + ':' + v.file), ['unpinned:' + NEW]);
        assert.ok(/--add/.test(bad[0].message));
        // One sorting before the newest pin is flagged with no base list (a shallow CI checkout), once.
        const OLD = '2098-12-31-missed.sql';
        const old = pin.findViolations({ files: { [FILE]: RAW, [OLD]: 'SELECT 1;' }, fixture, rebaselines: {} });
        assert.deepStrictEqual(old.map((v) => v.kind + ':' + v.file), ['unpinned:' + OLD]);
        assert.ok(/--add/.test(old[0].message));
        const both = pin.findViolations({ files: { [FILE]: RAW, [OLD]: 'SELECT 1;' }, fixture, rebaselines: {}, committed: [OLD] });
        assert.deepStrictEqual(both.map((v) => v.kind + ':' + v.file), ['unpinned:' + OLD]);
    });

    it('a committed file that is pinned, or an empty committed list, adds no violation', function () {
        assert.deepStrictEqual(pin.findViolations({ files: { [FILE]: RAW }, fixture, rebaselines: {}, committed: [FILE] }), []);
        assert.deepStrictEqual(pin.findViolations({ files: { [FILE]: RAW, 'x.sql': 'SELECT 1;' }, fixture, rebaselines: {}, committed: [] }), []);
    });
});

describe('migration executable-residue pin: a cloned rebaseline source is never executed @regression @tier1', function () {
    let dir;
    beforeEach(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebaseline-')); });
    afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

    it('parses the table as data and runs no code planted beside it', function () {
        const marker = path.join(dir, 'executed');
        const src = path.join(dir, 'checksum_rebaselines.js');
        fs.writeFileSync(src, "require('fs').writeFileSync(" + JSON.stringify(marker) + ", 'x');\n" +
            "const MIGRATION_CHECKSUM_REBASELINES = {\n  'a.sql': { from: ['" + 'a'.repeat(64) + "'], to: '" + 'b'.repeat(64) + "' },\n};\n");
        assert.deepStrictEqual(pin.readRebaselines(src), { 'a.sql': { from: ['a'.repeat(64)], to: 'b'.repeat(64) } });
        assert.strictEqual(fs.existsSync(marker), false);
    });

    it('rejects a table holding an expression instead of evaluating it', function () {
        const marker = path.join(dir, 'executed');
        const src = path.join(dir, 'checksum_rebaselines.js');
        fs.writeFileSync(src, "const MIGRATION_CHECKSUM_REBASELINES = {\n  'a.sql': { from: require('fs').writeFileSync(" +
            JSON.stringify(marker) + ", 'x'), to: 'b' },\n};\n");
        assert.throws(() => pin.readRebaselines(src));
        assert.strictEqual(fs.existsSync(marker), false);
    });
});

/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/consensus/consensus_identity/absent_sentinel.test.js
 *
 * bin/consensus-identity.js refuses (exit 2) when src/consensus_rules_digest.js
 * exports no ABSENT sentinel, the same way the hub's copy of the tool does. A
 * missing export would filter the gates on undefined, which no gate reads, so
 * --assert-no-absent would pass silently. The child-process case removes the
 * export through a preload written to a scratch directory, never under src/.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawnSync } = require('child_process');

const REPO  = path.resolve(__dirname, '../../../..');
const BIN   = path.join(REPO, 'bin', 'consensus-identity.js');
const RULES = path.join(REPO, 'src', 'consensus_rules_digest.js');

// A preload that deletes the ABSENT export from the rules module the child loads.
function droppedSentinelPreload() {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'identity-absent-')), 'drop_absent.js');
    fs.writeFileSync(file, 'delete require(' + JSON.stringify(RULES) + ').ABSENT;\n');
    return file;
}

function run(args, preload) {
    const argv = preload ? ['-r', preload, BIN, ...args] : [BIN, ...args];
    return spawnSync(process.execPath, argv, { cwd: REPO, encoding: 'utf8' });
}

describe('bin/consensus-identity.js the absent-gate sentinel', function () {
    this.timeout(60000);

    it('takes the sentinel from the rules module, which exports a non-empty one', function () {
        const { absentSentinel } = require(BIN);
        const rules = require(RULES);
        assert.strictEqual(typeof rules.ABSENT, 'string');
        assert.notStrictEqual(rules.ABSENT, '');
        assert.strictEqual(absentSentinel(rules), rules.ABSENT);
        assert.strictEqual(absentSentinel({ ABSENT: '<gone>' }), '<gone>');
    });

    it('refuses a rules module with a missing or empty sentinel', function () {
        const { absentSentinel } = require(BIN);
        assert.throws(() => absentSentinel({}), /exports no ABSENT sentinel/);
        assert.throws(() => absentSentinel({ ABSENT: '' }), /exports no ABSENT sentinel/);
    });

    it('exits 2 with no output when the export is gone, with or without --assert-no-absent', function () {
        const preload = droppedSentinelPreload();
        for (const args of [['--assert-no-absent', '--json'], ['--json']]) {
            const res = run(args, preload);
            assert.strictEqual(res.status, 2, args.join(' ') + res.stdout + res.stderr);
            assert.strictEqual(res.stdout, '');
            assert.match(res.stderr, /exports no ABSENT sentinel/);
            assert.strictEqual(res.stderr.trim().split('\n').length, 1, res.stderr);
        }
    });
});

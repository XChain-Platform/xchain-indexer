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
 * The carrier logic pin, held three ways: every pinned module still hashes to
 * its pin, every move since the last commit carries a re-pin record, and every
 * twin id hashes the same in the sibling repo. Runs on GitHub with no hook and
 * no database; the sibling checks skip when the sibling is not checked out
 * unless XCHAIN_REQUIRE_SIBLINGS=1, which turns the skip into a failure.
 *
 * A pin that can be regenerated silently guards nothing, which is why (b) reads
 * the pin at HEAD through git and refuses an entry that moved without a record.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { execFileSync } = require('child_process');

const pinModule = require('../../../bin/lib/carrier_logic_pin.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

/** The sibling's checkout when it carries `rel`, else null; the caller decides whether null skips or fails. */
function siblingWith(repo, rel) {
    const dir = pinModule.siblingDir(repo, REPO_ROOT);
    return fs.existsSync(path.join(dir, rel)) ? dir : null;
}

/** Skip or fail on a missing sibling, by the environment's rule. */
function missingSibling(test, repo) {
    if (REQUIRE_SIBLINGS) assert.fail(`${repo} is not checked out beside this repo and XCHAIN_REQUIRE_SIBLINGS=1`);
    test.skip();
}

describe('bin/pins/carrier-logic.json: the carrier logic pin', function () {
    this.timeout(30000);
    let pin;
    before(() => { pin = pinModule.readPin(REPO_ROOT); });

    it('(a) every entry hashes to its pin', () => {
        const measured = pinModule.measure(REPO_ROOT, pin);
        const moved = Object.keys(measured).filter((id) => !measured[id].ok)
            .map((id) => `${id} (${measured[id].path}): pinned ${measured[id].expected}, measured ${measured[id].actual}`);
        assert.deepStrictEqual(moved, [],
            'a moved entry is a logic change; re-pin it with bin/lib/carrier_logic_pin.js --write --id <id> --reason "<why>"');
    });

    it('(b) every entry that moved since HEAD carries a re-pin record', function () {
        const committed = pinModule.committedPin(REPO_ROOT);
        if (!committed) this.skip();
        const unrecorded = [];
        for (const id of Object.keys(pin.entries)) {
            const before = committed.entries[id];
            const hash = pin.entries[id].hash;
            if (before && before.hash === hash) continue;
            if (!(pin.repins || []).some((r) => r.id === id && r.to === hash)) unrecorded.push(id);
        }
        assert.deepStrictEqual(unrecorded, [],
            'a bare regenerate is refused: only --write or --add, each with a --reason, may move an entry');
    });

    it('(c) every twin id hashes the same in the sibling pin', function () {
        const mismatches = [];
        for (const id of Object.keys(pin.entries)) {
            for (const repo of pin.entries[id].twins || []) {
                const dir = siblingWith(repo, pinModule.PIN_REL);
                if (!dir) { missingSibling(this, repo); continue; }
                const theirs = (pinModule.readPin(dir).entries[id] || {}).hash;
                if (theirs !== pin.entries[id].hash) mismatches.push(`${id}: ${repo} pins ${theirs}, this repo pins ${pin.entries[id].hash}`);
            }
        }
        assert.deepStrictEqual(mismatches, [], 'a logic change to a twin re-pins every copy in one change set');
    });
});

// Same suite title on purpose: the readability limit is per callback, so the
// remaining cases sit in a second block and every full test title reads the same.
describe('bin/pins/carrier-logic.json: the carrier logic pin', function () {
    this.timeout(30000);
    let pin;
    before(() => { pin = pinModule.readPin(REPO_ROOT); });

    it('(d) the digest is stable and matches the CLI', () => {
        const hex = pinModule.digest(pin);
        assert.match(hex, /^[0-9a-f]{64}$/);
        assert.strictEqual(pinModule.digest(pinModule.readPin(REPO_ROOT)), hex);
        // A moved entry exits 1 and is (a)'s finding; this case reads the digest either way.
        let stdout;
        try {
            stdout = execFileSync(process.execPath, [path.join(REPO_ROOT, pinModule.MODULE_REL), '--json'], { cwd: REPO_ROOT });
        } catch (e) { stdout = e.stdout; }
        const cli = JSON.parse(stdout.toString('utf8'));
        assert.strictEqual(cli.carrier_logic_digest, hex);
        assert.deepStrictEqual(Object.keys(cli.entries).sort(), Object.keys(pin.entries).sort());
    });

    it('(e) the module bytes equal every sibling copy', function () {
        const mine = fs.readFileSync(path.join(REPO_ROOT, pinModule.MODULE_REL));
        for (const repo of pinModule.MODULE_TWINS) {
            if (repo === pinModule.repoName(REPO_ROOT)) continue;
            const dir = siblingWith(repo, pinModule.MODULE_REL);
            if (!dir) { missingSibling(this, repo); continue; }
            assert.ok(mine.equals(fs.readFileSync(path.join(dir, pinModule.MODULE_REL))),
                `${pinModule.MODULE_REL} differs from the ${repo} copy: edit one and cp it to the others`);
        }
    });
});

describe('bin/lib/carrier_logic_pin.js: tokenHash', () => {
    const base = "const dep = require('./dep');\nfunction f(n) { return n + 1; }\nmodule.exports = { f };\n";

    it('(f) ignores a comment, a reformat and a require path, and moves on an operator', () => {
        const hash = pinModule.tokenHash(base);
        assert.strictEqual(pinModule.tokenHash(`// a restored comment\n${base}`), hash, 'a comment is not logic');
        assert.strictEqual(pinModule.tokenHash(base.replace(/\n/g, '\n\n').replace(/ \{ /g, '{')), hash, 'whitespace is not logic');
        assert.strictEqual(pinModule.tokenHash(base.replace("'./dep'", "'../consensus/dep'")), hash, 'a require path is location, not logic');
        assert.notStrictEqual(pinModule.tokenHash(base.replace('n + 1', 'n - 1')), hash, 'an operator is logic');
        assert.notStrictEqual(pinModule.tokenHash(base.replace('n + 1', 'n + 2')), hash, 'a constant is logic');
        assert.notStrictEqual(pinModule.tokenHash(base.replace("{ f }", "{ f, k: 'v' }")), hash, 'a string outside require() is logic');
    });

    it('keys an entry by its stem under src/, without the extension', () => {
        assert.strictEqual(pinModule.moduleId('src/stateHash.js'), 'stateHash');
        assert.strictEqual(pinModule.moduleId('src/attestation/providerMinStakeHistory.js'), 'attestation/providerMinStakeHistory');
        assert.strictEqual(pinModule.moduleId('src/lib/fullnode_activation.js'), 'lib/fullnode_activation');
    });
});

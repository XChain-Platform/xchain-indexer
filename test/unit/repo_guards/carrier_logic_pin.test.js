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
 * The carrier logic pin, held four ways: every pinned module still hashes to
 * its pin, every change since the last commit (a re-pin, an addition, a
 * retirement, a move) carries a record of the right shape, every twin id
 * hashes the same in the sibling repo, and the membership rule and the pin
 * name the same files. Runs on GitHub with no hook and no database; the
 * sibling checks skip when the sibling is not checked out unless
 * XCHAIN_REQUIRE_SIBLINGS=1, which turns the skip into a failure.
 *
 * A pin that can be regenerated silently guards nothing, which is why (b) reads
 * the pin at HEAD through git and refuses an entry that moved without a record.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
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

    it('(b) every entry that changed, left or moved since HEAD carries a record', function () {
        const committed = pinModule.committedPin(REPO_ROOT);
        if (!committed) this.skip();
        assert.deepStrictEqual(pinModule.unrecordedChanges(committed, pin), [],
            'a bare regenerate is refused: only --write, --add, --retire or --move may change the pin, each leaving a repins record');
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

    it('(e) every twin file\'s bytes equal every sibling copy', function () {
        assert.ok(pinModule.MODULE_TWIN_FILES.length >= 2, 'the module and its ops half are both twins');
        for (const repo of pinModule.MODULE_TWINS) {
            if (repo === pinModule.repoName(REPO_ROOT)) continue;
            const dir = siblingWith(repo, pinModule.MODULE_REL);
            if (!dir) { missingSibling(this, repo); continue; }
            for (const rel of pinModule.MODULE_TWIN_FILES) {
                const theirs = path.join(dir, rel);
                assert.ok(fs.existsSync(theirs), `${rel} is missing from the ${repo} copy: cp it there`);
                assert.ok(fs.readFileSync(path.join(REPO_ROOT, rel)).equals(fs.readFileSync(theirs)),
                    `${rel} differs from the ${repo} copy: edit one and cp it to the others`);
            }
        }
    });

    it('(g) the membership rule and the pin name the same files, both ways', () => {
        const { unpinned, nonMembers } = pinModule.membershipDiff(REPO_ROOT, pin);
        assert.deepStrictEqual(unpinned.map((r) => `${r.id} (${r.path})`), [],
            'a carrier the tree holds and the pin does not: --add it (or --move a renamed one under its old id)');
        assert.deepStrictEqual(nonMembers.map((r) => `${r.id} (${r.path})`), [],
            'a pinned path the membership rule no longer yields: --retire a deleted carrier, --move a renamed one');
        // The tree side alone, so an entry can never satisfy (g) by being its own member.
        const treePaths = pinModule.members(REPO_ROOT, pin);
        assert.deepStrictEqual(treePaths, Object.keys(pin.entries).map((id) => pin.entries[id].path).sort());
    });
});

/**
 * A throwaway checkout with a pin over one module, so the operations are
 * driven against real files and a real pin without touching this repo's.
 */
function scratchRepo() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carrier-logic-pin-'));
    fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'bin', 'pins'), { recursive: true });
    const source = "const { activeAt } = require('./consensus/gate_registry');\nmodule.exports = { on: (h) => activeAt('k', h) };\n";
    fs.writeFileSync(path.join(dir, 'src', 'thing_activation.js'), source);
    const hash = pinModule.tokenHash(source);
    const pin = { version: 1, entries: { thing_activation: { path: 'src/thing_activation.js', hash, twins: [] } }, repins: [] };
    pinModule.writePin(dir, pin);
    return { dir, source, hash, pin: pinModule.readPin(dir) };
}

describe('bin/lib/carrier_logic_pin.js: --retire and --move', () => {
    let repo;
    beforeEach(() => { repo = scratchRepo(); });
    afterEach(() => { fs.rmSync(repo.dir, { recursive: true, force: true }); });

    it('(h) --retire removes the entry and records a move to nothing', () => {
        pinModule.retireEntry(repo.pin, 'thing_activation', 'row 18');
        assert.strictEqual(repo.pin.entries.thing_activation, undefined);
        const rec = repo.pin.repins[repo.pin.repins.length - 1];
        assert.deepStrictEqual({ id: rec.id, from: rec.from, to: rec.to, reason: rec.reason },
            { id: 'thing_activation', from: repo.hash, to: null, reason: 'row 18' });
        assert.throws(() => pinModule.retireEntry(repo.pin, 'thing_activation', 'again'), /not pinned/);
    });

    it('(i) --move keeps the id and hash, repoints the path, and records both paths', () => {
        // The renamed module: same tokens, a deeper require path, a comment on top.
        const moved = `// moved\n${repo.source.replace("'./consensus/gate_registry'", "'../consensus/gate_registry'")}`;
        fs.writeFileSync(path.join(repo.dir, 'src', 'deep', 'thing_gate.js'), moved);
        pinModule.moveEntry(repo.dir, repo.pin, 'thing_activation', 'src/deep/thing_gate.js', 'row 18');
        assert.deepStrictEqual(repo.pin.entries.thing_activation, { path: 'src/deep/thing_gate.js', hash: repo.hash, twins: [] });
        assert.strictEqual(pinModule.idForPath(repo.pin, 'src/deep/thing_gate.js'), 'thing_activation', 'a moved module keeps its id');
        assert.strictEqual(pinModule.idForPath(repo.pin, 'src/deep/other_gate.js'), 'deep/other_gate', 'an unpinned path derives one');
        const rec = repo.pin.repins[repo.pin.repins.length - 1];
        assert.deepStrictEqual({ id: rec.id, from: rec.from, to: rec.to, path: rec.path, reason: rec.reason },
            { id: 'thing_activation', from: repo.hash, to: repo.hash, path: { from: 'src/thing_activation.js', to: 'src/deep/thing_gate.js' }, reason: 'row 18' });
        assert.strictEqual(pinModule.digest(repo.pin), pinModule.digest(pinModule.readPin(repo.dir)), 'a move leaves the digest alone');
    });

    it('(j) --move is refused when the new path carries different logic, and the pin is untouched', () => {
        fs.writeFileSync(path.join(repo.dir, 'src', 'deep', 'thing_gate.js'), repo.source.replace("activeAt('k', h)", "!activeAt('k', h)"));
        assert.throws(() => pinModule.moveEntry(repo.dir, repo.pin, 'thing_activation', 'src/deep/thing_gate.js', 'row 18'),
            (e) => e.exitCode === 1 && /not the pinned logic/.test(e.message));
        assert.throws(() => pinModule.moveEntry(repo.dir, repo.pin, 'thing_activation', 'src/deep/missing_gate.js', 'row 18'), /does not exist/);
        assert.deepStrictEqual(repo.pin, pinModule.readPin(repo.dir), 'a refused move writes nothing');
    });
});

describe('bin/lib/carrier_logic_pin.js: the records rule (b) accepts and refuses', () => {
    const h1 = 'a'.repeat(64);
    const h2 = 'b'.repeat(64);
    const committed = { entries: { kept: { path: 'src/kept.js', hash: h1 }, gone: { path: 'src/gone.js', hash: h1 }, renamed: { path: 'src/renamed.js', hash: h2 } } };

    /** The committed pin with `gone` retired and `renamed` moved, under `repins`. */
    function after(repins) {
        return { entries: { kept: { path: 'src/kept.js', hash: h1 }, renamed: { path: 'src/deep/renamed_gate.js', hash: h2 } }, repins };
    }

    it('(k) accepts a retire record with to: null and a move record naming the new path', () => {
        const ok = after([
            { id: 'gone', from: h1, to: null, reason: 'r' },
            { id: 'renamed', from: h2, to: h2, path: { from: 'src/renamed.js', to: 'src/deep/renamed_gate.js' }, reason: 'r' },
        ]);
        assert.deepStrictEqual(pinModule.unrecordedChanges(committed, ok), []);
    });

    it('(l) refuses a retire with no record, naming the id', () => {
        const noRetire = after([{ id: 'renamed', from: h2, to: h2, path: { from: 'src/renamed.js', to: 'src/deep/renamed_gate.js' } }]);
        assert.deepStrictEqual(pinModule.unrecordedChanges(committed, noRetire).map((l) => l.split(':')[0]), ['gone']);
    });

    it('(m) refuses a move with no path record, even under a same-hash --write record', () => {
        const noMove = after([{ id: 'gone', from: h1, to: null }, { id: 'renamed', from: null, to: h2, reason: 'the initial pin' }]);
        assert.deepStrictEqual(pinModule.unrecordedChanges(committed, noMove).map((l) => l.split(':')[0]), ['renamed']);
        const noRecordAtAll = after([]);
        assert.deepStrictEqual(pinModule.unrecordedChanges(committed, noRecordAtAll).map((l) => l.split(':')[0]).sort(), ['gone', 'renamed']);
    });

    it('(n) still refuses a changed hash and an addition without a record', () => {
        const changed = { entries: { kept: { path: 'src/kept.js', hash: h2 }, gone: committed.entries.gone, renamed: committed.entries.renamed, added: { path: 'src/added.js', hash: h1 } }, repins: [] };
        assert.deepStrictEqual(pinModule.unrecordedChanges(committed, changed).map((l) => l.split(':')[0]).sort(), ['added', 'kept']);
        changed.repins.push({ id: 'kept', from: h1, to: h2 }, { id: 'added', from: null, to: h1 });
        assert.deepStrictEqual(pinModule.unrecordedChanges(committed, changed), []);
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

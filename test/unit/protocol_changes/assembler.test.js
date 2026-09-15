'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The entry module's public shape against the committed HEAD copy: every
// reader that requires src/protocol_changes.js today must find the same own
// properties with the same values, plus the registry API and nothing else.
// HEAD's copy is loaded from a temp file (it requires nothing at load), so the
// comparison is against the bytes git holds, not against this tree's memory.

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');

const REPO  = path.resolve(__dirname, '..', '..', '..');
const ENTRY = path.join(REPO, 'src', 'protocol_changes.js');
const PARTS = path.join(REPO, 'src', 'protocol_changes');
const API_ENUMERABLE = ['get', 'activeAt', 'rows', 'RegistryMissError'];
const API_HIDDEN = ['registry', 'UNARMED', 'UNPINNED'];

function headSource() {
    return execFileSync('git', ['show', 'HEAD:src/protocol_changes.js'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
}

function loadHeadCopy(text) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-head-'));
    const file = path.join(dir, 'protocol_changes.js');
    fs.writeFileSync(file, text);
    try { return require(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('protocol_changes/assembler: the public export shape is unchanged @regression @tier1', function () {
    let head, now, headText;
    before(function () {
        headText = headSource();
        head = loadHeadCopy(headText);
        now = require(ENTRY);
    });

    it('exports every own property HEAD exports, with the same value, and only the registry API besides', function () {
        const headKeys = Object.keys(head).sort();
        const nowKeys = Object.keys(now).sort();
        assert.ok(headKeys.length >= 19, 'HEAD exports ' + headKeys.length + ' names; too few to be the real module');
        assert.deepStrictEqual(nowKeys, headKeys.concat(API_ENUMERABLE).sort());
        for (const k of headKeys) {
            if (typeof head[k] === 'function') assert.strictEqual(typeof now[k], 'function', k);
            else assert.strictEqual(now[k], head[k], k + ' value moved');
        }
        assert.strictEqual(typeof now, 'function', 'module.exports is still the class');
        assert.strictEqual(now.name, head.name);
    });

    it('registry, UNARMED and UNPINNED are present but non-enumerable, so the manifest sees no new data export', function () {
        for (const k of API_HIDDEN) {
            const d = Object.getOwnPropertyDescriptor(now, k);
            assert.ok(d, k + ' missing');
            assert.strictEqual(d.enumerable, false, k + ' must not enumerate');
        }
        assert.strictEqual(now.UNARMED, 9999999999);
        assert.strictEqual(now.UNPINNED, null);
        assert.strictEqual(typeof now.registry.addGate, 'function');
        assert.strictEqual(now.get('protocol_changes.changes.SEND'), now.registry.get('protocol_changes.changes.SEND'));
    });

    it('still constructs under the manifest stub with 97 prototype-free changes, same as HEAD', function () {
        const stub = () => ({ config: {}, util: {} });
        const table = new now(stub()).changes;
        assert.strictEqual(Object.keys(table).length, 97);
        assert.strictEqual(Object.getPrototypeOf(table), null);
        assert.deepStrictEqual(Object.keys(table), Object.keys(new head(stub()).changes), 'registration order changed');
        for (const name of Object.keys(table)) assert.deepStrictEqual(table[name], new head(stub()).changes[name], name);
    });

    it('the entry ends smaller than HEAD and every part file fits the readability limits', function () {
        const lines = (t) => t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
        const entryLines = lines(fs.readFileSync(ENTRY, 'utf8'));
        assert.ok(entryLines < lines(headText), 'entry ' + entryLines + ' lines must be below HEAD ' + lines(headText));
        const files = fs.readdirSync(PARTS).filter((f) => f.endsWith('.js')).sort();
        assert.ok(files.length >= 8 && files.length <= 20, files.length + ' part files');
        for (const f of files) {
            const n = lines(fs.readFileSync(path.join(PARTS, f), 'utf8'));
            assert.ok(n <= 400, f + ' is ' + n + ' lines');
        }
    });
});

describe('protocol_changes/assembler: the part files declare no carrier and the SHARED block is well formed @regression @tier1', function () {
    const ACTIVATION_MAP = /\b([A-Z][A-Z0-9_]*_ACTIVATION)\s*=\s*\{/g;
    const CARRIER_DECL = /^\s*(?:const|let|var)\s+([A-Z0-9_]*ACTIVATIONS?[A-Z0-9_]*)\s*=\s*(?:Object\.freeze\()?\{/gm;

    it('no part file matches the carrier declaration scans (D38)', function () {
        for (const f of fs.readdirSync(PARTS)) {
            const text = fs.readFileSync(path.join(PARTS, f), 'utf8');
            assert.deepStrictEqual([...text.matchAll(ACTIVATION_MAP)].map((m) => m[1]), [], f);
            assert.deepStrictEqual([...text.matchAll(CARRIER_DECL)].map((m) => m[1]), [], f);
        }
    });

    it('shared_rows.js carries the two markers once each, in order, with no require between them', function () {
        const text = fs.readFileSync(path.join(PARTS, 'shared_rows.js'), 'utf8');
        const begin = text.indexOf('\n// SHARED-GATES BEGIN\n');
        const end = text.indexOf('\n// SHARED-GATES END\n');
        assert.ok(begin > 0 && end > begin, 'markers missing or out of order');
        assert.strictEqual(text.split('// SHARED-GATES BEGIN').length, 2, 'BEGIN must appear exactly once');
        assert.strictEqual(text.split('// SHARED-GATES END').length, 2, 'END must appear exactly once');
        const block = text.slice(begin, end);
        assert.ok(!/require\s*\(/.test(block), 'the SHARED block is data only');
        for (const line of block.split('\n').filter((l) => l.trim() && !l.startsWith('// SHARED-GATES'))) {
            assert.ok(/^(\/\/|addGate\(|    )/.test(line), 'a block line is a comment, an addGate call or its continuation: ' + line);
        }
    });

    it('the time-table parts hold exactly the 97 rows, in registration order, and nothing but rows', function () {
        const parts = fs.readdirSync(PARTS).filter((f) => /^changes_\d+\.js$/.test(f)).sort();
        assert.ok(parts.length >= 4, parts.join(','));
        const names = [];
        for (const f of parts) {
            const rows = require(path.join(PARTS, f));
            assert.ok(Array.isArray(rows) && rows.length > 0, f);
            for (const row of rows) {
                assert.strictEqual(row.length, 8, f + ': ' + row[0]);
                names.push(row[0]);
            }
        }
        assert.strictEqual(names.length, 97);
        assert.deepStrictEqual(names, Object.keys(new (require(ENTRY))({ config: {}, util: {} }).changes));
    });
});

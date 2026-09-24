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

// Guard the XChainIndexer composition root: Object.assign resolves a duplicate
// method name silently by argument order, so a name exported by two method tables,
// or one that shadows a class-body method, would leave one family's method answering
// as another's. The table list is read from the Object.assign call itself, so a
// table added there is covered without editing this file.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..', '..', 'src');
const ROOT_FILE = path.join(SRC, 'XChainIndexer.js');

// Map each identifier in the prototype Object.assign call to the module and key it comes from.
function composedTables(source) {
    const call = /Object\.assign\(\s*XChainIndexer\.prototype\s*,([^)]*)\)/.exec(source);
    assert.ok(call, 'src/XChainIndexer.js no longer composes its prototype with Object.assign; update this guard');
    const names = call[1].split(',').map((s) => s.trim()).filter(Boolean);
    const requires = [...source.matchAll(/const\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\('(\.\/XChainIndexer\/[^']+)'\)/g)];
    return names.map((name) => {
        for (const [, lhs, rel] of requires) {
            const destructured = lhs.startsWith('{');
            const bound = destructured ? lhs.slice(1, -1).split(',').map((s) => s.trim()) : [lhs];
            if (!bound.includes(name)) continue;
            const mod = require(path.join(SRC, rel));
            return { name, rel, table: destructured ? mod[name] : mod };
        }
        assert.fail(`method table ${name} is composed but not required from ./XChainIndexer/`);
    });
}

describe('XChainIndexer prototype composition @tier1', function () {
    const source = fs.readFileSync(ROOT_FILE, 'utf8');
    const tables = composedTables(source);

    it('reads a non-trivial set of method tables from the composition call', function () {
        assert.ok(tables.length >= 10, `expected the composed tables, found ${tables.length}`);
        for (const { name, table } of tables) {
            assert.ok(table && typeof table === 'object', `${name} is not a method table`);
            assert.ok(Object.keys(table).length > 0, `${name} contributes no methods`);
        }
    });

    it('no method name is exported by two composed tables', function () {
        const owner = new Map();
        const dupes = [];
        for (const { name, table } of tables) {
            for (const key of Object.keys(table)) {
                if (owner.has(key)) dupes.push(`${key} (${owner.get(key)} and ${name})`);
                else owner.set(key, name);
            }
        }
        assert.deepStrictEqual(dupes, [], `duplicate method names across tables: ${dupes.join(', ')}`);
    });

    it('no composed method shadows a class-body method', function () {
        const XChainIndexer = require(ROOT_FILE);
        const shadowed = [];
        for (const { name, table } of tables) {
            for (const key of Object.keys(table)) {
                const desc = Object.getOwnPropertyDescriptor(XChainIndexer.prototype, key);
                // A class-body method is non-enumerable, and Object.assign keeps that flag when it overwrites.
                if (!desc || !desc.enumerable) shadowed.push(`${key} (${name})`);
                else assert.strictEqual(desc.value, table[key], `${key} on the prototype is not ${name}'s method`);
            }
        }
        assert.deepStrictEqual(shadowed, [], `composed methods shadowing class-body methods: ${shadowed.join(', ')}`);
    });
});

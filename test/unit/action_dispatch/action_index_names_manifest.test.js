// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Bind every ACTION name the indexer writes into the actions table to the vendored
// manifest. The dispatch guard sees only switch names, so a settlement-anchor row minted
// through createActionIndex could be renamed or added with every other guard still green.

const assert = require('assert');
const fs   = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const VENDORED = path.join(__dirname, '..', '..', 'fixtures', 'action-manifest.json');
const MANIFEST = JSON.parse(fs.readFileSync(VENDORED, 'utf8'));

// Strip comments so a name quoted in prose never counts as a write.
function decomment(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
}

// Every .js file under a directory, recursively, in a stable order.
function jsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
        .flatMap(e => e.isDirectory() ? jsFiles(path.join(dir, e.name))
            : (e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
}

// The two shapes that name a written row: an object literal `ACTION: 'X'` and an
// assignment `x['ACTION'] = 'X'` feeding a call site that passes a variable.
function nameRes() {
    return [/\bACTION\s*:\s*'([A-Z0-9_]+)'/g, /\[\s*'ACTION'\s*\]\s*=\s*'([A-Z0-9_]+)'/g];
}

// Match the third shape, a settled parent row renamed in place: `updateActionIndex(i, 'X')`.
function renameRe() {
    return /\bupdateActionIndex\s*\([^;]*?,\s*'([A-Z0-9_]+)'\s*\)/g;
}

// Name the manifest category whose members are exactly the indexer's in-place renames.
const RENAME_CATEGORY = 'explorer-legacy-render';

// Read every source file as a [relative path, decommented text] pair.
function srcTexts() {
    return jsFiles(SRC).map(f => [path.relative(SRC, f), decomment(fs.readFileSync(f, 'utf8'))]);
}

// Map each name the given regexes find to the files that write it (UNKNOWN is the sentinel).
function namesIn(sources, res) {
    const found = new Map();
    for (const [file, text] of sources) {
        for (const re of res) {
            for (const m of text.matchAll(re)) {
                if (m[1] === 'UNKNOWN') continue;
                if (!found.has(m[1])) found.set(m[1], new Set());
                found.get(m[1]).add(file);
            }
        }
    }
    return found;
}

// Report renames the manifest category does not list, and members nothing renames to.
function renameDrift(renamed, actions) {
    const listed = Object.keys(actions).filter(n => actions[n].category === RENAME_CATEGORY);
    return {
        unlisted: [...renamed.keys()].filter(n => !listed.includes(n)).sort(),
        unwritten: listed.filter(n => !renamed.has(n)).sort(),
    };
}

describe('ACTION manifest conformance: indexer-written action names @regression', function () {
    const sources = srcTexts();
    const renamed = namesIn(sources, [renameRe()]);
    const written = namesIn(sources, [...nameRes(), renameRe()]);

    it('the scan reaches the settlement anchors and a realistic share of written names', function () {
        assert.ok(written.has('XPOLICY'), 'scan no longer finds the XPOLICY anchor write');
        assert.ok(written.has('LIST_SHARE'), 'scan no longer finds the LIST_SHARE anchor write');
        assert.ok(renamed.has('DISPENSER_CANCEL') && renamed.has('ORDER_EDIT'),
            'scan no longer finds the updateActionIndex renames; a regex or path change emptied it');
        assert.ok(written.size >= 15, 'scan found only ' + written.size + ' written names; a regex or path change emptied it');
    });

    it('the rename category lists exactly the names the indexer renames rows to', function () {
        assert.deepStrictEqual(renameDrift(renamed, MANIFEST.actions), { unlisted: [], unwritten: [] },
            'the manifest ' + RENAME_CATEGORY + ' category and the indexer updateActionIndex renames have drifted. ' +
            'Give a new rename an entry in that category (explorerRender only) and re-vendor, or drop a stale one.');
    });

    it('a rename write the manifest category does not list is reported', function () {
        const fake = namesIn([['fake.js', "await db.updateActionIndex(data['ACTION_INDEX'], 'DISPENSER_BOGUS');"]], [renameRe()]);
        assert.deepStrictEqual(renameDrift(fake, MANIFEST.actions).unlisted, ['DISPENSER_BOGUS']);
        assert.ok(renameDrift(new Map(), MANIFEST.actions).unwritten.includes('DISPENSER_EDIT'),
            'a category member nothing renames to must be reported as unwritten');
    });

    it('every action name the indexer writes has a manifest entry', function () {
        const missing = [...written.keys()].filter(n => !(n in MANIFEST.actions)).sort()
            .map(n => n + ' (' + [...written.get(n)].join(', ') + ')');
        assert.deepStrictEqual(missing, [],
            'indexer writes actions the manifest does not list: ' + missing.join('; ') +
            '. Add a manifest entry (category settlement-anchor for a system-minted row) and re-vendor.');
    });

    it('every settlement-anchor manifest action is still written by the indexer', function () {
        const stale = Object.entries(MANIFEST.actions)
            .filter(([, v]) => v.category === 'settlement-anchor')
            .map(([k]) => k).filter(n => !written.has(n)).sort();
        assert.deepStrictEqual(stale, [],
            'manifest lists settlement anchors the indexer no longer writes: ' + stale.join(', '));
    });
});

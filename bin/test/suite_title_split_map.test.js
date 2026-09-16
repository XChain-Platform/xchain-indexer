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
 * What a declared test-file split is allowed to be, which is the only thing
 * standing between "the suite was reorganised" and "the suite quietly lost
 * tests". The split map is the mechanism that lets a reviewer accept one file
 * becoming several without reading every title, so each way it could wave a
 * loss through is driven here against a known answer: a title dropped, a title
 * carried by two parts, a title that went to a file the record never named,
 * and a title that appeared from nowhere.
 *
 * The maps are fixtures rather than real collections, because a real one is a
 * six-megabyte pin that moves under every lane of the pass; the grading is
 * pure, so a fixture drives it exactly as the pin does, and the real pin is
 * only asked to load and validate.
 *
 * This suite is outside test/ on purpose: every npm test script globs from
 * test/, and the pass pins those scripts' collected titles. Run it directly:
 *
 *   npx mocha --no-config --timeout 30000 bin/test/suite_title_split_map.test.js
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { compare } = require('../suite-title-map.js');
const splitMap    = require('../suite_title_map/split_map.js');

const OLD = 'test/unit/db_queries.test.js';
const ORDERS = 'test/unit/db_queries/orders.test.js';
const STAKES = 'test/unit/db_queries/stakes.test.js';
const OTHER = 'test/unit/other.test.js';
const SPLIT = { [OLD]: [ORDERS, STAKES] };

const OLD_TITLES = ['db orders reads', 'db orders writes', 'db stakes reads', 'db stakes writes'];
const PIN = { test: { [OLD]: OLD_TITLES, [OTHER]: ['other one'] } };
const FRESH = {
    test: {
        [ORDERS]: ['db orders reads', 'db orders writes'],
        [STAKES]: ['db stakes reads', 'db stakes writes'],
        [OTHER]: ['other one'],
    },
};

/** A title map in the pin's on-disk shape, out of {script: {file: [titles]}}. */
function mapOf(scripts) {
    const titleSets = {};
    const out = {};
    let n = 0;
    for (const name of Object.keys(scripts)) {
        const files = {};
        for (const rel of Object.keys(scripts[name])) {
            const key = `set${n += 1}`;
            titleSets[key] = scripts[name][rel].slice().sort();
            files[rel] = key;
        }
        out[name] = { files };
    }
    return { titleSets, scripts: out };
}

/** The compare the CLI runs: pin against tree, through a rename map and a split map. */
function run(pin, fresh, splits, renames) {
    return splitMap.compareWithSplits({
        pin: mapOf(pin), fresh: mapOf(fresh), renames: renames || {}, splits, compare,
    });
}

/** One fresh tree with a single title moved from the part it belongs in to somewhere else. */
function moveTitle(from, to, title) {
    const tree = JSON.parse(JSON.stringify(FRESH));
    tree.test[from] = tree.test[from].filter((t) => t !== title);
    if (to) tree.test[to] = (tree.test[to] || []).concat([title]);
    return tree;
}

const kinds = (diffs) => diffs.map((d) => d.kind).sort();

describe('bin/suite_title_map/split_map.js: a declared split that is honest', () => {
    it('reports nothing when the parts carry exactly the old file titles', () => {
        assert.deepStrictEqual(run(PIN, FRESH, SPLIT), []);
    });

    it('is the record that carries it: without one, the same tree is a wall of differences', () => {
        const diffs = compare(mapOf(PIN), mapOf(FRESH), {}, undefined);
        assert.deepStrictEqual(kinds(diffs), ['file_added', 'file_added', 'file_dropped']);
    });

    it('lets one part keep the old path', () => {
        const tree = { test: { [OLD]: ['db orders reads', 'db orders writes'], [STAKES]: ['db stakes reads', 'db stakes writes'], [OTHER]: ['other one'] } };
        assert.deepStrictEqual(run(PIN, tree, { [OLD]: [OLD, STAKES] }), []);
    });

    it('keeps a title the old file reported twice, once in each part', () => {
        const pin = { test: { [OLD]: ['same title', 'same title'] } };
        const twice = { test: { [ORDERS]: ['same title'], [STAKES]: ['same title'] } };
        assert.deepStrictEqual(run(pin, twice, SPLIT), []);
        const once = { test: { [ORDERS]: ['same title'], [STAKES]: [] } };
        assert.deepStrictEqual(kinds(run(pin, once, SPLIT)), ['title_dropped']);
    });

    it('does not mind a part a filtered script collects nothing from', () => {
        const pin = { 'test:regression': { [OLD]: ['db orders reads @regression'] } };
        const tree = { 'test:regression': { [ORDERS]: ['db orders reads @regression'] } };
        assert.deepStrictEqual(run(pin, tree, SPLIT), []);
    });

    it('takes the path the file has after the rename map, not the one the pin holds', () => {
        const pin = { test: { 'test/unit/db-queries.test.js': OLD_TITLES } };
        const renames = { 'test/unit/db-queries.test.js': OLD };
        assert.deepStrictEqual(run(pin, FRESH, SPLIT, renames).filter((d) => d.file !== OTHER), []);
    });
});

describe('bin/suite_title_map/split_map.js: what a declared split still refuses', () => {
    it('refuses a title that no part carries any more', () => {
        const diffs = run(PIN, moveTitle(STAKES, null, 'db stakes writes'), SPLIT);
        assert.deepStrictEqual(diffs, [{ script: 'test', kind: 'title_dropped', file: OLD, title: 'db stakes writes' }]);
    });

    it('refuses a title two parts both carry', () => {
        const tree = JSON.parse(JSON.stringify(FRESH));
        tree.test[STAKES] = tree.test[STAKES].concat(['db orders reads']);
        const diffs = run(PIN, tree, SPLIT);
        assert.deepStrictEqual(diffs, [{
            script: 'test', kind: 'title_duplicated', file: `${ORDERS}, ${STAKES}`, title: 'db orders reads',
        }]);
    });

    it('refuses a title that moved to a file the record does not name, and says where it went', () => {
        const diffs = run(PIN, moveTitle(STAKES, OTHER, 'db stakes writes'), SPLIT);
        const moved = diffs.filter((d) => d.kind === 'title_moved_outside_split');
        assert.deepStrictEqual(moved, [{
            script: 'test', kind: 'title_moved_outside_split', file: `${OLD} -> ${OTHER}`, title: 'db stakes writes',
        }]);
        // The file it landed in is a pinned file of its own, so the ordinary
        // compare reports the arrival as well: the split hides nothing from it.
        assert.deepStrictEqual(kinds(diffs), ['title_added', 'title_moved_outside_split']);
    });

    it('refuses a title that moved to a file nobody pinned at all', () => {
        const diffs = run(PIN, moveTitle(STAKES, 'test/unit/stray.test.js', 'db stakes writes'), SPLIT);
        assert.deepStrictEqual(kinds(diffs), ['file_added', 'title_moved_outside_split']);
    });

    it('refuses a title the old file never had', () => {
        const tree = JSON.parse(JSON.stringify(FRESH));
        tree.test[ORDERS] = tree.test[ORDERS].concat(['db orders brand new']);
        assert.deepStrictEqual(run(PIN, tree, SPLIT), [{
            script: 'test', kind: 'title_added', file: ORDERS, title: 'db orders brand new',
        }]);
    });

    it('grades every other file exactly as before', () => {
        const tree = JSON.parse(JSON.stringify(FRESH));
        tree.test[OTHER] = ['other renamed'];
        assert.deepStrictEqual(kinds(run(PIN, tree, SPLIT)), ['title_added', 'title_dropped']);
    });
});

describe('bin/suite_title_map/split_map.js: the record has to mean one thing', () => {
    it('refuses a single destination, which is a rename', () => {
        assert.deepStrictEqual(kinds(run(PIN, FRESH, { [OLD]: [ORDERS] })), ['split_record']);
    });

    it('refuses one part claimed by two old files', () => {
        const splits = { [OLD]: [ORDERS, STAKES], [OTHER]: [STAKES, 'test/unit/other_more.test.js'] };
        const diffs = run(PIN, FRESH, splits);
        assert.deepStrictEqual(kinds(diffs), ['split_record']);
        assert.ok(diffs[0].detail.includes(STAKES));
    });

    it('refuses a part that is itself split', () => {
        const splits = { [OLD]: [ORDERS, OTHER], [OTHER]: [STAKES, 'test/unit/other_more.test.js'] };
        assert.deepStrictEqual(kinds(run(PIN, FRESH, splits)), ['split_record']);
    });

    it('refuses merging into a file that is already pinned', () => {
        const tree = { test: { [ORDERS]: ['db orders reads', 'db orders writes'], [OTHER]: ['other one', 'db stakes reads', 'db stakes writes'] } };
        const diffs = run(PIN, tree, { [OLD]: [ORDERS, OTHER] });
        // Three ways at once, which is the point: the part is called out by
        // name, the titles it already held read as a surplus in the union, and
        // its own pin entry is left with nothing collecting it.
        assert.deepStrictEqual(kinds(diffs), ['file_dropped', 'split_part_collides', 'title_added']);
        assert.deepStrictEqual(diffs[0], {
            script: 'test',
            kind: 'split_part_collides',
            file: OTHER,
            detail: `already pinned, so it cannot take tests from ${OLD}`,
        });
    });

    it('grades nothing else once the record is refused', () => {
        const tree = JSON.parse(JSON.stringify(FRESH));
        tree.test[OTHER] = ['other renamed'];
        assert.deepStrictEqual(run(tree, FRESH, { [OLD]: [ORDERS] }).length, 1);
    });

    it('refuses a map that is not an object of lists', () => {
        assert.deepStrictEqual(splitMap.validateSplits([OLD, ORDERS]).length, 1);
        assert.deepStrictEqual(splitMap.validateSplits({ [OLD]: ORDERS }).length, 1);
    });
});

describe('bin/suite_title_map/split_map.js: reading the record off disk', () => {
    const pins = path.join(__dirname, '..', 'pins');

    it('reads the splits out of the house record', () => {
        const splits = splitMap.loadSplits(path.join(pins, 'suite-title-splits.json'));
        assert.deepStrictEqual(typeof splits, 'object');
        assert.deepStrictEqual(splitMap.validateSplits(splits), []);
    });

    it('takes a file with no splits key as the map itself', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-map-'));
        const flat = path.join(dir, 'flat.json');
        fs.writeFileSync(flat, JSON.stringify(SPLIT));
        try {
            assert.deepStrictEqual(splitMap.loadSplits(flat), SPLIT);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('keeps the declared example a legal split', () => {
        const record = JSON.parse(fs.readFileSync(path.join(pins, 'suite-title-splits.json'), 'utf8'));
        assert.deepStrictEqual(splitMap.validateSplits(record.example), []);
    });
});

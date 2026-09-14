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
 * One pinned test file declared as several, for bin/suite-title-map.js.
 *
 * WHY A SEPARATE RECORD. The rename map is one-to-one on purpose: a pure move
 * keeps a file's whole title set under one new key, so the ordinary per-file
 * compare still proves nothing entered or left it. A file split into several
 * cannot be written as renames, and comparing each new file on its own reports
 * the old file dropped and every part added, a wall of differences a reviewer
 * ends up waving through by eye. That is exactly the failure the pin exists to
 * stop, so a split is declared, and graded as one unit.
 *
 * WHAT HOLDS. For every script that pinned the old file, the titles the named
 * parts collect, taken together, equal the old file's titles exactly, counted
 * as a multiset: no title lost, none added, none carried by two parts (a title
 * mocha reported twice in the old file must appear twice in total). A title
 * that left the old file for a file the record does not name is reported as
 * moved, with where it went, rather than as a bare drop, so the record has to
 * account for every title's destination.
 *
 * A part that a script does not collect is not itself a finding: under a
 * --grep script a part can hold no matching title at all. Only the union is
 * graded, and a title the old file never had shows up as added either way.
 *
 * RENAMES APPLY FIRST. The split map is keyed by the path the compare sees
 * once the rename map has been applied to the pin, which is the path the file
 * has in the tree just before it is split.
 *
 * THE RECORD. Either a house record whose `splits` key holds the map
 * (bin/pins/suite-title-splits.json) or a flat object of the same shape:
 *   { "test/unit/a.test.js": ["test/unit/a_reads.test.js", "test/unit/a_writes.test.js"] }
 * A part may keep the old path. Every part list names at least two files; a
 * single destination is a rename and belongs in --rename-map.
 *
 ********************************************************************/

'use strict';

const fs = require('fs');

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** The split map in a record file: a house record's `splits`, or the flat object itself. */
function loadSplits(file) {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record && typeof record === 'object' && !Array.isArray(record) && hasOwn(record, 'splits')) {
        return record.splits;
    }
    return record;
}

/**
 * What is wrong with a split map before any title is read. A record that names
 * one part under two old files, or makes a part of a file it also splits, has
 * no single meaning, so it is refused whole rather than compared.
 * @returns {string[]} one line per problem; empty when the map is usable
 */
function validateSplits(splits) {
    if (!splits || typeof splits !== 'object' || Array.isArray(splits)) {
        return ['the split map is not an object of {old: [new, ...]}'];
    }
    const problems = [];
    const owner = {};
    for (const old of Object.keys(splits)) {
        const parts = splits[old];
        if (!Array.isArray(parts) || parts.length < 2 || !parts.every((p) => typeof p === 'string' && p)) {
            problems.push(`${old}: parts must be a list of at least two paths`);
            continue;
        }
        for (const part of parts) {
            if (hasOwn(owner, part)) problems.push(`${part}: named by ${owner[part]} and by ${old}`);
            else owner[part] = old;
        }
    }
    for (const part of Object.keys(owner)) {
        if (part !== owner[part] && hasOwn(splits, part)) problems.push(`${part}: a part of ${owner[part]} and itself split`);
    }
    return problems;
}

/** The flat {file: [titles]} of one script, or null when the map did not collect it. */
function filesOf(map, name) {
    const s = map.scripts[name];
    if (!s || !s.files) return null;
    const out = {};
    for (const rel of Object.keys(s.files)) out[rel] = map.titleSets[s.files[rel]] || [];
    return out;
}

/** A script's pinned files under their renamed paths, and which pin keys each came from. */
function renamedView(before, renames) {
    const mapped = {};
    const origin = {};
    for (const rel of Object.keys(before)) {
        const name = renames[rel] || rel;
        mapped[name] = before[rel];
        (origin[name] = origin[name] || []).push(rel);
    }
    return { mapped, origin };
}

/** How many times each title occurs across some title lists. */
function countTitles(lists) {
    const counts = new Map();
    for (const list of lists) for (const t of list) counts.set(t, (counts.get(t) || 0) + 1);
    return counts;
}

/** Titles the parts carry fewer times than the old file did: dropped, or moved outside the record. */
function missingTitles({ script, old, named, after }, expected, got) {
    const out = [];
    for (const [title, want] of expected) {
        const have = got.get(title) || 0;
        if (have >= want) continue;
        const elsewhere = Object.keys(after).filter((rel) => !named.has(rel) && after[rel].includes(title)).sort();
        const kind = elsewhere.length ? 'title_moved_outside_split' : 'title_dropped';
        const file = elsewhere.length ? `${old} -> ${elsewhere.join(', ')}` : old;
        for (let i = have; i < want; i += 1) out.push({ script, kind, file, title });
    }
    return out;
}

/** Titles the parts carry more times than the old file did: added, or duplicated across parts. */
function surplusTitles({ script, parts, after }, expected, got) {
    const out = [];
    for (const [title, have] of got) {
        const want = expected.get(title) || 0;
        if (have <= want) continue;
        const holders = parts.filter((p) => (after[p] || []).includes(title)).join(', ');
        const kind = want ? 'title_duplicated' : 'title_added';
        for (let i = want; i < have; i += 1) out.push({ script, kind, file: holders, title });
    }
    return out;
}

/**
 * Every difference one split makes in one script. `mapped` is the pin's view
 * of the script with renames applied, `after` the tree's.
 */
function gradeSplit({ script, old, parts, mapped, after }) {
    const out = [];
    // A part that is already a pinned file of its own would be a merge, and the
    // titles it already had would be graded twice or not at all.
    for (const part of parts) {
        if (part !== old && mapped[part]) {
            out.push({ script, kind: 'split_part_collides', file: part, detail: `already pinned, so it cannot take tests from ${old}` });
        }
    }
    const ctx = { script, old, parts, named: new Set(parts), after };
    const expected = countTitles([mapped[old]]);
    const got = countTitles(parts.map((p) => after[p] || []));
    return out.concat(missingTitles(ctx, expected, got), surplusTitles(ctx, expected, got));
}

/** A shallow copy of a map with some files removed from some scripts. */
function withoutFiles(map, dropByScript) {
    const scripts = {};
    for (const name of Object.keys(map.scripts)) {
        const s = map.scripts[name];
        const drop = dropByScript[name];
        if (!drop || !s.files) { scripts[name] = s; continue; }
        const files = {};
        for (const rel of Object.keys(s.files)) if (!drop.has(rel)) files[rel] = s.files[rel];
        scripts[name] = { ...s, files };
    }
    return { ...map, scripts };
}

/**
 * compare() from bin/suite-title-map.js with a split map in front of it. Each
 * split is graded here, then the old file is taken out of the pin and its parts
 * out of the tree for that script, so the ordinary compare grades every other
 * file exactly as it did before and a pin with no splits compares unchanged.
 */
function compareWithSplits({ pin, fresh, renames, splits, only, compare }) {
    const problems = validateSplits(splits);
    if (problems.length) return problems.map((detail) => ({ script: '*', kind: 'split_record', detail }));
    const differences = [];
    const dropPin = {};
    const dropFresh = {};
    for (const name of Object.keys(pin.scripts).filter((n) => !only || n === only).sort()) {
        const before = filesOf(pin, name);
        const after = filesOf(fresh, name);
        if (!before || !after) continue;
        const { mapped, origin } = renamedView(before, renames);
        for (const old of Object.keys(splits).sort()) {
            if (!mapped[old]) continue;
            differences.push(...gradeSplit({ script: name, old, parts: splits[old], mapped, after }));
            const pinned = (dropPin[name] = dropPin[name] || new Set());
            for (const rel of origin[old]) pinned.add(rel);
            const parts = (dropFresh[name] = dropFresh[name] || new Set());
            for (const part of splits[old]) parts.add(part);
        }
    }
    return differences.concat(compare(withoutFiles(pin, dropPin), withoutFiles(fresh, dropFresh), renames, only));
}

module.exports = { loadSplits, validateSplits, compareWithSplits };

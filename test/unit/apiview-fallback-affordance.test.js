/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * The apiView() fallback is a TEST AFFORDANCE, not a production path .
 *
 * Three sites read through `typeof db.apiView === 'function' ? db.apiView() : db`
 * so a minimal test double without apiView still runs: the reorg driver's
 * indexerReorgView (XChainIndexer.js), the rollback read phase (rollback.js) and
 * committedView() (health.js). Nothing else may take that shape. apiView() is
 * what gives a read an independent pooled connection that sees only committed
 * state, so a silent raw-db fallback on a federation READ would re-open the
 * dirty read REORG-1  exist to prevent.
 *
 *  is the concrete failure this guards: an e2e double carrying only
 * doQuery/getPubkeyId/getStatusId hit stake-source.js and died on
 * "indexer.indexerDb.apiView is not a function". The fix went to the DOUBLE, not
 * to the call site. This suite keeps that decision from eroding: the fallback
 * stays unreachable against the real Database, its three sites stay documented
 * as an affordance, and a fourth site has to argue with a failing test.
 *********************************************************************/

'use strict';

const assert   = require('assert');
const fs       = require('fs');
const path     = require('path');
const Database = require('../../src/db');

const SRC_DIR = path.join(__dirname, '../../src');

// The only files allowed to carry the guarded fallback, each mapped to the note
// that has to survive beside it.
const ALLOWED_SITES = ['XChainIndexer.js', 'rollback.js', 'health.js'];

// `typeof <anything>.apiView === 'function'` in either operand order.
const FALLBACK_SHAPE = /typeof\s+[^;\n]*?\.apiView\s*===?\s*['"]function['"]|['"]function['"]\s*===?\s*typeof\s+[^;\n]*?\.apiView/;

function srcFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...srcFiles(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

// Lines carrying the fallback shape, each paired with the comment lines in the
// 25 lines above it. A window rather than the contiguous block directly above:
// health.js documents the fallback on committedView()'s own doc comment, one
// line further up than the guarded return statement.
const NOTE_WINDOW = 25;

function fallbackSites(source) {
    const lines = source.split('\n');
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith('//')) continue;
        if (!FALLBACK_SHAPE.test(lines[i])) continue;
        const comment = lines.slice(Math.max(0, i - NOTE_WINDOW), i)
            .map(l => l.trim()).filter(l => l.startsWith('//')).join('\n');
        hits.push({ line: i + 1, code: lines[i].trim(), comment });
    }
    return hits;
}

describe('apiView() fallback is a test affordance  @regression @tier1', function () {

    it('the real Database defines apiView(), so the fallback branch is unreachable in production', function () {
        assert.strictEqual(typeof Database.prototype.apiView, 'function',
            'Database.prototype.apiView is gone: every `typeof db.apiView === "function"` guard would ' +
            'now silently fall back to the raw db, which is a dirty read on the block transaction, not a fallback');
    });

    it('only the three known sites carry the guarded fallback', function () {
        const offenders = [];
        for (const file of srcFiles(SRC_DIR)) {
            const rel = path.relative(SRC_DIR, file);
            if (ALLOWED_SITES.includes(rel)) continue;
            for (const hit of fallbackSites(fs.readFileSync(file, 'utf8')))
                offenders.push(rel + ':' + hit.line + '  ' + hit.code);
        }
        assert.deepStrictEqual(offenders, [],
            'new apiView() fallback site(s). A read that may silently drop to the raw db is a dirty ' +
            'read waiting to happen : give the failing test double an ' +
            '`apiView(){ return this }` instead of guarding the call site.\n  ' + offenders.join('\n  '));
    });

    for (const site of ALLOWED_SITES) {
        it(site + ' still names its fallback a test affordance and points at ', function () {
            const source = fs.readFileSync(path.join(SRC_DIR, site), 'utf8');
            const hits = fallbackSites(source);
            assert.ok(hits.length > 0, site + ' no longer has an apiView() fallback; drop it from ALLOWED_SITES');
            for (const hit of hits) {
                assert.match(hit.comment, /test affordance/i,
                    site + ':' + hit.line + ' must say the fallback is a test affordance, not a production path');
                assert.match(hit.comment, //,
                    site + ':' + hit.line + ' must cite , where the reasoning is recorded');
            }
        });
    }
});

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Cross-repo ACTION-manifest conformance guard. Forgetting to dispatch a new
// ACTION in the indexer coerces it to UNKNOWN and no-ops; worse, one validator
// having it and another not is a LEDGER FORK. The authoritative set lives in
// xchain-documentation/protocol/action-manifest.json (vendored here). This guard
// asserts the indexer's dispatch switch equals the manifest's indexerHandled
// slice. Note: protocol_changes ALSO holds non-action feature flags (VM_ACTIONS,
// CONTROLLER_GUARD, ...), so we compare the DISPATCH switch, not the registry.

const assert = require('assert');
const fs   = require('fs');
const path = require('path');

const VENDORED = path.join(__dirname, '..', 'fixtures', 'action-manifest.json');
const MANIFEST = JSON.parse(fs.readFileSync(VENDORED, 'utf8'));

function decomment(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
}
function manifestSlice(flag) {
    return Object.entries(MANIFEST.actions).filter(([, v]) => v[flag]).map(([k]) => k).sort();
}
function localIndexerSet() {
    const src = decomment(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'actions.js'), 'utf8'));
    const names = [...new Set([...src.matchAll(/action\s*==\s*'([A-Z_]+)'/g)].map(x => x[1]))];
    return names.filter(n => n !== 'UNKNOWN').sort(); // UNKNOWN is the catch-all sentinel, not an action
}

describe('ACTION manifest conformance: indexer indexerHandled set @regression', function () {
    it('the action dispatch switch exactly equals the manifest indexerHandled slice', function () {
        const expected = manifestSlice('indexerHandled');
        const actual   = localIndexerSet();
        const missing = expected.filter(a => !actual.includes(a)); // manifest says handle, indexer forgot -> UNKNOWN/no-op (fork risk)
        const extra   = actual.filter(a => !expected.includes(a));  // indexer dispatches, manifest unaware
        assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] },
            'indexer dispatch drifted from action-manifest.json indexerHandled set. ' +
            'MISSING (in manifest, not dispatched -> coerced to UNKNOWN / ledger-fork risk): ' + JSON.stringify(missing) +
            '. EXTRA (dispatched, not in manifest): ' + JSON.stringify(extra) +
            '. Edit xchain-documentation/protocol/action-manifest.json + re-vendor, or wire src/actions.js.');
    });

    // #2721: the manifest's `aliases` map is expanded to canonical names before any gate
    // (indexer ACTION_ALIASES module constant in src/actions.js, ~line 62; the constructor
    // copies it into this.actionAliases via Object.assign, #3133/#3189). It was copied into
    // the indexer with no conformance guard: a sixth alias added on only one side decodes on
    // one and coerces to UNKNOWN on the other (the same silent-drop / ledger-fork class the
    // dispatch guard above prevents, reached through the alias door). Bind the single
    // ACTION_ALIASES source to the manifest.
    it('the indexer ACTION_ALIASES map exactly equals the manifest aliases map', function () {
        const src = decomment(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'actions.js'), 'utf8'));
        const local = {};
        const blockMatch = src.match(/const ACTION_ALIASES\s*=\s*\{([\s\S]*?)\};/);
        assert.ok(blockMatch, 'ACTION_ALIASES object literal not found in src/actions.js');
        for (const m of blockMatch[1].matchAll(/'([A-Z_]+)'\s*:\s*'([A-Z_]+)'/g)) {
            local[m[1]] = m[2];
        }
        const expected = MANIFEST.aliases || {};
        assert.deepStrictEqual(local, expected,
            'indexer actionAliases (src/actions.js) drifted from action-manifest.json aliases. ' +
            'indexer=' + JSON.stringify(local) + ' manifest=' + JSON.stringify(expected) +
            '. Edit xchain-documentation/protocol/action-manifest.json + re-vendor, or wire src/actions.js.');
    });

    describe('byte-identity to canonical manifest', function () {
        const DOCS = process.env.XCHAIN_DOCS_DIR || path.join(__dirname, '..', '..', '..', 'xchain-documentation');
        const CANON = path.join(DOCS, 'protocol', 'action-manifest.json');
        before(function () { if (!fs.existsSync(CANON)) { if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but canonical action-manifest.json not found at ' + CANON); this.skip(); } });
        it('vendored test/fixtures/action-manifest.json is byte-identical to canonical', function () {
            assert.strictEqual(fs.readFileSync(VENDORED, 'utf8'), fs.readFileSync(CANON, 'utf8'),
                'vendored action-manifest.json drifted from canonical; edit ' +
                'xchain-documentation/protocol/action-manifest.json and re-vendor all copies.');
        });
    });

    // #2694: bind the module-private FEE_QUOTE_DENYLIST / FEE_QUOTE_EXEMPT sets to the dispatch
    // table via the exported classifier, so a name added to either set (or removed from dispatch)
    // cannot drift silently. Reuses localIndexerSet() as the dispatch-scraper.
    describe('fee-quote classification conformance @regression', function () {
        const Actions = require('../../src/actions.js');
        const denied  = Actions.getFeeQuoteDenylist();
        const exempt  = Actions.getFeeQuoteExempt();

        it('(a) every dispatched action classifies as exactly one of denied/exempt/quotable', function () {
            const dispatched = localIndexerSet();
            for (const a of dispatched) {
                const c = Actions.classifyFeeQuoteAction(a);
                assert.ok(['denied', 'exempt', 'quotable'].includes(c),
                    a + ' classified as unexpected value ' + JSON.stringify(c));
            }
        });

        it('(b) denied and exempt sets are disjoint', function () {
            const overlap = [...denied].filter(a => exempt.has(a));
            assert.deepStrictEqual(overlap, [], 'denied/exempt overlap: ' + JSON.stringify(overlap));
        });

        it('(c) neither set contains a name absent from the dispatch table', function () {
            const dispatched = new Set(localIndexerSet());
            const orphaned = [...denied, ...exempt].filter(a => !dispatched.has(a));
            assert.deepStrictEqual(orphaned, [],
                'deny/exempt names not in the dispatch table: ' + JSON.stringify(orphaned));
        });

        it('(d) denied set equals exactly {DEPLOY, EXECUTE, XEXEC, BATCH}', function () {
            assert.deepStrictEqual([...denied].sort(), ['BATCH', 'DEPLOY', 'EXECUTE', 'XEXEC']);
        });
    });
});

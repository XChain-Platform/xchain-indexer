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

    describe('byte-identity to canonical manifest', function () {
        const DOCS = process.env.XCHAIN_DOCS_DIR || path.join(__dirname, '..', '..', '..', 'xchain-documentation');
        const CANON = path.join(DOCS, 'protocol', 'action-manifest.json');
        before(function () { if (!fs.existsSync(CANON)) this.skip(); });
        it('vendored test/fixtures/action-manifest.json is byte-identical to canonical', function () {
            assert.strictEqual(fs.readFileSync(VENDORED, 'utf8'), fs.readFileSync(CANON, 'utf8'),
                'vendored action-manifest.json drifted from canonical; edit ' +
                'xchain-documentation/protocol/action-manifest.json and re-vendor all copies.');
        });
    });
});

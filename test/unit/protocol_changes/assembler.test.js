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

// The entry module's public shape against the shape it had before the split:
// every reader that requires src/protocol_changes.js must find the same own
// properties, each constant equal to the part file that now declares it, plus
// the registry API and nothing else. The pre-split names are pinned here as a
// literal (the committed HEAD is itself the split form since row 11).

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');

const REPO  = path.resolve(__dirname, '..', '..', '..');
const ENTRY = path.join(REPO, 'src', 'protocol_changes.js');
const PARTS = path.join(REPO, 'src', 'protocol_changes');
const API_ENUMERABLE = ['get', 'copy', 'activeAt', 'rows', 'RegistryMissError'];
// The entry's own enumerable exports before the split (indexer 4d5e2d0a): 17
// constants, two predicates, the pin's no-op proof, the version pin.
const EXPORTS_BEFORE_SPLIT = [
    'VM_BANNED_ASYNC_MAINNET_TIME', 'NATIVE_FEE_PRICE_TIME_GATE_MAINNET_TIME', 'isNativeFeePriceTimeGateActive',
    'CONSENSUS_VERSION', 'assertConsensusVersionPin', 'UNCAPPED_MAX_SUPPLY_ZERO_MAINNET_TIME',
    'CROSS_SETTLE_CAP_MAINNET_TIME', 'BATCH_ROOT_SUB_INDEX_MAINNET_TIME', 'ISSUE_INHERITED_MINT_WINDOW_MAINNET_TIME',
    'ISSUE_INHERITED_MINT_WINDOW_TESTNET_TIME', 'DEPLOY_DEFERRED_ASSEMBLY_MAINNET_TIME',
    'DEPLOY_DEFERRED_ASSEMBLY_TESTNET_TIME', 'CONTRACT_META_REQUIRED_MAINNET_TIME', 'CONTRACT_META_REQUIRED_TESTNET_TIME',
    'BATCH_ISSUANCE_LIMITS_MAINNET_TIME', 'BATCH_COST_WEIGHTING_MAINNET_TIME', 'EMISSION_ISSUANCE_LIMITS_MAINNET_TIME',
    'UNIFIED_FEES_SWEEP_CALLBACK_MAINNET_TIME', 'UNIFIED_FEES_SWEEP_CALLBACK_TESTNET_TIME',
];
const API_HIDDEN = ['registry', 'UNARMED', 'UNPINNED'];

function headSource() {
    return execFileSync('git', ['show', 'HEAD:src/protocol_changes.js'], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
}

// Every constant the entry re-exports, read from the part files that declare it.
function partConstants() {
    return Object.assign({},
        require(path.join(PARTS, 'flag_times.js')),
        require(path.join(PARTS, 'flag_times_batch_fees.js')),
        require(path.join(PARTS, 'consensus_version.js')));
}

describe('protocol_changes/assembler: the public export shape is unchanged @regression @tier1', function () {
    let now, headText;
    before(function () {
        headText = headSource();
        now = require(ENTRY);
    });

    it('exports every own property it exported before the split, each constant equal to its part file, and only the registry API besides', function () {
        const nowKeys = Object.keys(now).sort();
        assert.deepStrictEqual(nowKeys, EXPORTS_BEFORE_SPLIT.concat(API_ENUMERABLE).sort());
        const parts = partConstants();
        for (const k of EXPORTS_BEFORE_SPLIT) {
            if (typeof now[k] === 'function') continue;
            assert.strictEqual(now[k], parts[k], k + ' value differs from its part file');
            assert.strictEqual(now.get('protocol_changes.' + k), now[k], k + ' is not the registry row');
        }
        assert.strictEqual(typeof now, 'function', 'module.exports is still the class');
        assert.strictEqual(now.name, 'ProtocolChanges');
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

    it('still constructs under the manifest stub with 98 prototype-free changes, equal to the registry rows', function () {
        const stub = () => ({ config: {}, util: {} });
        const table = new now(stub()).changes;
        assert.strictEqual(Object.keys(table).length, 98);
        assert.strictEqual(Object.getPrototypeOf(table), null);
        const rows = now.rows().filter(([k]) => k.startsWith('protocol_changes.changes.'));
        assert.deepStrictEqual(Object.keys(table), rows.map(([k]) => k.slice('protocol_changes.changes.'.length)), 'registration order changed');
        for (const [k, v] of rows) assert.deepStrictEqual(table[k.slice('protocol_changes.changes.'.length)], v, k);
    });

    it('the entry ends no larger than HEAD and every part file fits the readability limits', function () {
        const lines = (t) => t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
        const entryLines = lines(fs.readFileSync(ENTRY, 'utf8'));
        assert.ok(entryLines <= lines(headText), 'entry ' + entryLines + ' lines must not be above HEAD ' + lines(headText));
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

    it('every shared_rows_N.js carries the two markers once each, in order, with no require between them, and nothing but rows outside them', function () {
        const parts = fs.readdirSync(PARTS).filter((f) => /^shared_rows_\d+\.js$/.test(f)).sort();
        assert.ok(parts.length >= 1, 'no SHARED block part');
        for (const f of parts) {
            const text = fs.readFileSync(path.join(PARTS, f), 'utf8');
            const begin = text.indexOf('\n// SHARED-GATES BEGIN\n');
            const end = text.indexOf('\n// SHARED-GATES END\n');
            assert.ok(begin > 0 && end > begin, f + ': markers missing or out of order');
            assert.strictEqual(text.split('// SHARED-GATES BEGIN').length, 2, f + ': BEGIN must appear exactly once');
            assert.strictEqual(text.split('// SHARED-GATES END').length, 2, f + ': END must appear exactly once');
            const block = text.slice(begin, end);
            assert.ok(!/require\s*\(/.test(block), f + ': the SHARED block is data only');
            assert.ok(!/process\.env|readFileSync|__dirname/.test(block), f + ': the SHARED block reads nothing');
            for (const line of block.split('\n').filter((l) => l.trim() && !l.startsWith('// SHARED-GATES'))) {
                assert.ok(/^(\/\/|\/\*|\*|addGate\(|[ \t]|[\]})]*\)?;$)/.test(line), f + ': a block line is a comment, an addGate call or its continuation: ' + line);
            }
            // Outside the markers: the header, 'use strict', the ONE require line, nothing else.
            const outside = text.slice(0, begin) + text.slice(end + '\n// SHARED-GATES END\n'.length);
            const code = outside.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
            assert.deepStrictEqual(code, ["'use strict';", "const { addGate, UNARMED, UNPINNED } = require('./shared_rows.js');"], f);
        }
    });

    it('the time-table parts hold exactly the 98 rows, in registration order, and nothing but rows', function () {
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
        assert.strictEqual(names.length, 98);
        assert.deepStrictEqual(names, Object.keys(new (require(ENTRY))({ config: {}, util: {} }).changes));
    });
});

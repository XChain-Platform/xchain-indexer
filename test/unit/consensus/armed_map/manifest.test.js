/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * The armed-map manifest's completeness guard (W3 shape) and collectRows().
 *
 * MEMBERSHIP IS THE REGISTRY. Since the carriers became shims, every table
 * the process applies is a registry row, and the manifest is rows() plus the
 * seventeen VM mirror rows. What this guard has to catch is the one way a table
 * can escape that: a map literal declared somewhere under src/ instead of in
 * a registry part file. So the scan that used to check "declared, therefore
 * listed" now fails on ANY declaration outside src/protocol_changes/, and the
 * count it expects is zero.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const SRC  = path.join(REPO, 'src');
const PARTS = path.join(SRC, 'protocol_changes');

const manifest = require('../../../../src/consensus/armed_map/manifest.js');
const { canonicalValue } = require('../../../../src/consensus/armed_map/canonical.js');
const ProtocolChanges = require('../../../../src/protocol_changes.js');
const { GATE_MODULE_PATHS, REPLACED_STEMS, REGISTRY_ONLY_STEMS } = require('../../../helpers/gate_modules.js');

// The two declaration shapes that made a file a carrier. ACTIVATION_MAP is the
// activation-map rule the platform's code-structure gate grades with, and
// CARRIER_DECL is the scan fingerprint v1 enforced, each given a capture group
// here so a hit names the declared export.
const ACTIVATION_MAP = /\b([A-Z][A-Z0-9_]*_ACTIVATION)\s*=\s*\{/g;
const CARRIER_DECL = /^\s*(?:const|let|var)\s+([A-Z0-9_]*ACTIVATIONS?[A-Z0-9_]*)\s*=\s*(?:Object\.freeze\()?\{/gm;

function rowKeys() {
    return new Set(manifest.ENTRIES.map((e) => e[0]));
}

function declarationsIn(text, rel) {
    const names = new Set();
    for (const re of [ACTIVATION_MAP, CARRIER_DECL]) {
        for (const m of text.matchAll(re)) names.add(m[1]);
    }
    return [...names].map((name) => [rel, name]);
}

// [file relative to src/, declared name] for every declaration under src/.
function scanDeclarations(root) {
    const found = [];
    (function walk(dir, rel) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === '.git') continue;
            const abs = path.join(dir, e.name);
            const r = rel ? rel + '/' + e.name : e.name;
            if (e.isDirectory()) { walk(abs, r); continue; }
            if (!e.name.endsWith('.js')) continue;
            const text = fs.readFileSync(abs, 'utf8');
            found.push(...declarationsIn(text, r));
        }
    })(root, '');
    return found;
}

// The modules the registry replaced: any *_activation.js still at the top of
// src/ (none since W5; the scan stays so a shim that reappears is counted), the
// logic-bearing modules W4 and W5 moved under their feature directories and
// src/consensus/ (keyed by the registry stem they kept, the four carriers
// included, per test/helpers/gate_modules.js), and the two fixed modules that
// never moved, read as the running process resolves them.
const FIXED = ['protocol/constants.js', 'attestation/providerMinStakeHistory.js'];
function shimModules() {
    const top = fs.readdirSync(SRC).filter((f) => f.endsWith('_activation.js')).sort()
        .map((rel) => [rel.replace(/\.js$/, ''), rel]);
    const moved = Object.entries(GATE_MODULE_PATHS);
    return top.concat(moved, FIXED.map((rel) => [rel.replace(/\.js$/, ''), rel]))
        .map(([stem, rel]) => [stem, require(path.join(SRC, rel))]);
}

describe('armed_map/manifest: completeness guard', function () {

    it('no activation map or carrier is declared anywhere under src/ outside the registry part files', function () {
        const found = scanDeclarations(SRC);
        const outside = found.filter(([f]) => !f.startsWith('protocol_changes/'));
        assert.deepStrictEqual(outside.map(([f, n]) => f + ':' + n), [],
            'a table declared outside src/protocol_changes/ is applied by nobody and hashed by nobody; ' +
            'it belongs in a registry part file as an addGate() row');
        // The part files write rows as addGate() calls, so the scan must find
        // nothing there either: a match would be a literal that escaped the rule.
        assert.deepStrictEqual(found.map(([f, n]) => f + ':' + n), []);
    });

    it('the scan still finds a declaration when one exists (it is not vacuous)', function () {
        const found = declarationsIn('const X_ACTIVATION = { mainnet: 1 };\n', 'x_activation.js')
            .concat(declarationsIn('const MIN_STAKE_ACTIVATIONS = Object.freeze({ mainnet: {} });\n', 'y.js'));
        assert.deepStrictEqual(found.sort(), [['x_activation.js', 'X_ACTIVATION'], ['y.js', 'MIN_STAKE_ACTIVATIONS']]);
    });

    it('every non-function export of every shim module is a row, and every row but the time table, the VM mirror and the W4-replaced predicates is exported by one', function () {
        const keys = rowKeys();
        const missing = [];
        const exported = new Set();
        for (const [stem, mod] of shimModules()) {
            for (const name of Object.keys(mod)) {
                if (typeof mod[name] === 'function') continue;
                exported.add(stem + '.' + name);
                if (!keys.has(stem + '.' + name)) missing.push(stem + '.' + name);
            }
        }
        assert.deepStrictEqual(missing, [], 'exported data outside the v2 rows: ' + missing.join(', '));
        // A row nobody exports is read only through activeAt() by its literal
        // key: that is exactly the W4 census plus the registry-only rows, one row
        // per stem, and a new row that no module and no list names still reds here.
        const stems = REPLACED_STEMS.concat(REGISTRY_ONLY_STEMS,
            ['price_landed_strict_activation', 'anchor_preactivation_status_activation',
                'mainnet_launch_activation', 'prelaunch_seed_sources']);
        const unexported = [...keys].filter((k) => !k.startsWith('protocol_changes.') && !k.startsWith('xchain-vm.') && !exported.has(k));
        const replaced = [...keys].filter((k) => stems.includes(k.slice(0, k.lastIndexOf('.'))));
        assert.strictEqual(replaced.length, stems.length + 1,
            'the predicate rows plus the PRICE_LANDING_CHAINS constant are registry-only');
        assert.deepStrictEqual(unexported, replaced, 'rows no shim exports, beyond the W4-replaced set: ' +
            unexported.filter((k) => !replaced.includes(k)).join(', '));
    });

});

describe('armed_map/manifest: the row list', function () {

    it('carries the registry rows first, in registry order, then the VM mirror rows', function () {
        const registryKeys = ProtocolChanges.rows().map(([k]) => k);
        const keys = manifest.ENTRIES.map((e) => e[0]);
        assert.deepStrictEqual(keys.slice(0, registryKeys.length), registryKeys);
        assert.deepStrictEqual(keys.slice(registryKeys.length), manifest.VM_EXPORT_NAMES.concat(manifest.VM_ACCESSORS_EXPORT_NAMES).map((n) => 'xchain-vm.' + n));
        assert.strictEqual(manifest.VM_EXPORT_NAMES.length, 21);
        assert.deepStrictEqual(manifest.VM_ACCESSORS_EXPORT_NAMES, ['ACCESSOR_OWN_KEY_ACTIVATION']);
    });

    it('carries exactly the ProtocolChanges table as protocol_changes.changes.* rows', function () {
        const table = Object.keys(new ProtocolChanges({ config: {}, util: {} }).changes).sort();
        const rows = [...rowKeys()].filter((k) => k.startsWith('protocol_changes.changes.')).map((k) => k.slice('protocol_changes.changes.'.length)).sort();
        assert.deepStrictEqual(rows, table);
    });

    it('never lists a key twice and never enumerates the file system', function () {
        assert.strictEqual(rowKeys().size, manifest.ENTRIES.length);
        for (const file of ['manifest.js', 'fingerprint.js', 'canonical.js']) {
            const text = fs.readFileSync(path.join(SRC, 'consensus', 'armed_map', file), 'utf8');
            // A call or an fs require, not the word: the manifest header names readdirSync
            // in prose to say it is never called.
            assert.ok(!/\breaddirSync\s*\(|require\(\s*['"](?:node:)?fs['"]\s*\)/.test(text),
                file + ' must not read the file system');
        }
        const text = fs.readFileSync(path.join(SRC, 'consensus', 'armed_map', 'manifest.js'), 'utf8');
        assert.ok(!/require\(['"]\.\.\/\.\.\/[a-z_]+_activation\.js['"]\)/.test(text), 'the manifest lists no module any more');
    });
});

// The v0.23.0 cut armed these gates on testnet. The armed values are read from the
// registry rather than repeated here, so the cases grade the manifest against the row and
// pin only the shape the arming train writes: mainnet and the bare testnet fallback on the
// sentinel for a height gate, one sized height per testnet chain, regtest at genesis.
function assertSizedTestnetSlot(value, label) {
    assert.ok(Number.isInteger(value) && value > 1 && value < ProtocolChanges.UNARMED,
        label + ' is not a sized testnet activation: ' + value);
}

function assertArmedHeightRow(row) {
    assert.strictEqual(row.mainnet, ProtocolChanges.UNARMED);
    assert.strictEqual(row.testnet, ProtocolChanges.UNARMED, 'the bare testnet fallback stays on the sentinel');
    assert.strictEqual(row.regtest, 0);
    for (const coin of ['BTC', 'LTC', 'DOGE']) assertSizedTestnetSlot(row[coin + ':testnet'], coin + ':testnet');
}

describe('armed_map/manifest: collectRows', function () {

    it('resolves every entry to a serialisable value, in manifest order', function () {
        const res = manifest.collectRows();
        assert.strictEqual(res.ok, true, res.reason);
        assert.deepStrictEqual(res.rows.map((r) => r[0]), manifest.ENTRIES.map((e) => e[0]));
        for (const [, value] of res.rows) canonicalValue(value);
        // Counted from the registry and the VM mirror lists, never a literal: a
        // literal moved with every registry row, so two rows built side by side
        // always conflicted on this line.
        assert.strictEqual(res.rows.length,
            ProtocolChanges.rows().length + manifest.VM_EXPORT_NAMES.length + manifest.VM_ACCESSORS_EXPORT_NAMES.length);
    });

    it('carries the relay-response deadline time gate', function () {
        const key = 'attest_relay_response_deadline_activation.ATTEST_RELAY_RESPONSE_DEADLINE_ACTIVATION';
        const byKey = new Map(manifest.collectRows().rows);
        const row = byKey.get(key);
        assert.deepStrictEqual(row, { ...ProtocolChanges.get(key) });
        assert.deepStrictEqual(Object.keys(row).sort(),
            ['BTC:testnet', 'DOGE:testnet', 'LTC:testnet', 'mainnet', 'regtest', 'testnet']);
        assert.strictEqual(row.mainnet, ProtocolChanges.UNARMED);
        assert.strictEqual(row.regtest, 0);
        // A time gate arms one instant for the whole network, so the bare fallback carries
        // it too and every chain agrees.
        assertSizedTestnetSlot(row.testnet, 'testnet');
        for (const coin of ['BTC', 'LTC', 'DOGE']) assert.strictEqual(row[coin + ':testnet'], row.testnet, coin);
        assert.strictEqual(ProtocolChanges.registry.unitOf(key), 'time');
    });

    it('carries the cross-chain remote-token gate heights', function () {
        const byKey = new Map(manifest.collectRows().rows);
        const key = 'cross_chain_remote_token_activation.CROSS_CHAIN_REMOTE_TOKEN_ACTIVATION';
        const row = byKey.get(key);
        assert.deepStrictEqual(row, { ...ProtocolChanges.get(key) });
        assert.strictEqual(Object.keys(row).length, 6);
        assertArmedHeightRow(row);
    });

    it('carries the unarmed batch-airdrop leg-weight gate', function () {
        const byKey = new Map(manifest.collectRows().rows);
        const key = 'batch_airdrop_leg_weight_activation.BATCH_AIRDROP_LEG_WEIGHT_ACTIVATION';
        const row = byKey.get(key);
        assert.deepStrictEqual(row, { ...ProtocolChanges.get(key) });
        assert.deepStrictEqual(row, {
            mainnet: ProtocolChanges.UNARMED,
            'BTC:testnet': 157295,
            'LTC:testnet': 4930117,
            'DOGE:testnet': 68015000,
            testnet: ProtocolChanges.UNARMED,
            regtest: 0,
        });
    });

    it('carries the unarmed bridge-checkpoint v3 section gate', function () {
        const byKey = new Map(manifest.collectRows().rows);
        const key = 'bridge_checkpoint_v3_section_activation.BRIDGE_CHECKPOINT_V3_SECTION_ACTIVATION';
        const row = byKey.get(key);
        assert.deepStrictEqual(row, { ...ProtocolChanges.get(key) });
        assert.deepStrictEqual(row, {
            mainnet: ProtocolChanges.UNARMED,
            'BTC:testnet': 157295,
            'LTC:testnet': 4930117,
            'DOGE:testnet': 68015000,
            testnet: ProtocolChanges.UNARMED,
            regtest: 0,
        });
    });

    it('carries the unarmed null-prototype TICK cache gate', function () {
        const byKey = new Map(manifest.collectRows().rows);
        const key = 'tick_cache_null_prototype_activation.TICK_CACHE_NULL_PROTOTYPE_ACTIVATION';
        const row = byKey.get(key);
        assert.deepStrictEqual(row, { ...ProtocolChanges.get(key) });
        assert.deepStrictEqual(row, {
            mainnet: ProtocolChanges.UNARMED,
            'BTC:testnet': 157295,
            'LTC:testnet': 4930117,
            'DOGE:testnet': 68015000,
            testnet: ProtocolChanges.UNARMED,
            regtest: 0,
        });
    });

    it('carries the unarmed airdrop native-fee tally rollback gate', function () {
        const byKey = new Map(manifest.collectRows().rows);
        const key = 'airdrop_native_fee_tally_rollback_activation.AIRDROP_NATIVE_FEE_TALLY_ROLLBACK_ACTIVATION';
        const row = byKey.get(key);
        assert.deepStrictEqual(row, { ...ProtocolChanges.get(key) });
        assert.deepStrictEqual(row, {
            mainnet: ProtocolChanges.UNARMED,
            'BTC:testnet': 157295,
            'LTC:testnet': 4930117,
            'DOGE:testnet': 68015000,
            testnet: ProtocolChanges.UNARMED,
            regtest: 0,
        });
    });

    it('carries the unarmed guard emitted-host discriminator gate', function () {
        const byKey = new Map(manifest.collectRows().rows);
        const key = 'guard_emitted_host_discriminator_activation.GUARD_EMITTED_HOST_DISCRIMINATOR_ACTIVATION';
        const row = byKey.get(key);
        assert.deepStrictEqual(row, { ...ProtocolChanges.get(key) });
        assert.deepStrictEqual(row, {
            mainnet: ProtocolChanges.UNARMED,
            'BTC:testnet': 157295,
            'LTC:testnet': 4930117,
            'DOGE:testnet': 68015000,
            testnet: ProtocolChanges.UNARMED,
            regtest: 0,
        });
    });

    it('carries the unarmed archive v1 reissue refusal gate', function () {
        const byKey = new Map(manifest.collectRows().rows);
        const key = 'archive_v1_reissue_refusal_activation.ARCHIVE_V1_REISSUE_REFUSAL_ACTIVATION';
        const row = byKey.get(key);
        assert.deepStrictEqual(row, { ...ProtocolChanges.get(key) });
        assert.deepStrictEqual(row, {
            mainnet: ProtocolChanges.UNARMED,
            'BTC:testnet': 157295,
            'LTC:testnet': 4930117,
            'DOGE:testnet': 68015000,
            testnet: ProtocolChanges.UNARMED,
            regtest: 0,
        });
    });

    it('carries the three row families the design names', function () {
        const keys = rowKeys();
        assert.ok(keys.has('state_commitment_activation.STATE_COMMITMENT_ACTIVATION'), 'an activation map');
        assert.ok(keys.has('anchor_archive_fold_term_activation.ANCHOR_ARCHIVE_FOLD_TERM_ACTIVATION'), 'the anchor archive fold-term activation map');
        assert.ok(keys.has('protocol/constants.XBRIDGE_MAX_PER_BLOCK'), 'a fixed-carrier constant');
        assert.ok(keys.has('stateHash.DEACTIVATION_TABLES'), 'a fixed-carrier array');
        assert.ok(keys.has('protocol_changes.changes.SEND'), 'a ProtocolChanges row');
        assert.ok(keys.has('protocol_changes.CONSENSUS_VERSION'), 'the registry\'s own constant');
        assert.ok(keys.has('mirror_admission_activation.CHAIN_CODE_RE'), 'a RegExp row');
        assert.ok(keys.has('mirror_admission_margin_activation.ADMIT_CHAIN_MARGIN_ACTIVATION'), 'the chain-margin activation');
        assert.ok(keys.has('mirror_admission_margin_activation.ADMIT_CHAIN_MARGIN_BLOCKS'), 'the chain-margin table');
    });

    it('carries the DOGE mirror-admission chain margins and activation', function () {
        const byKey = new Map(manifest.collectRows().rows);
        const key = 'mirror_admission_margin_activation.ADMIT_CHAIN_MARGIN_ACTIVATION';
        const row = byKey.get(key);
        assert.deepStrictEqual(row, { ...ProtocolChanges.get(key) });
        assert.deepStrictEqual(Object.keys(row).sort(), ['DOGE:mainnet', 'DOGE:testnet', 'mainnet', 'regtest']);
        assert.strictEqual(row.mainnet, null);
        assert.strictEqual(row['DOGE:mainnet'], null);
        assertSizedTestnetSlot(row['DOGE:testnet'], 'DOGE:testnet');
        assert.strictEqual(row.regtest, 0);
        assert.deepStrictEqual(byKey.get('mirror_admission_margin_activation.ADMIT_CHAIN_MARGIN_BLOCKS').DOGE, {
            bridge_transfers: 14,
            cross_chain_calls: 14,
            cross_chain_matches: 14,
            list_snapshots: 14,
            policy_snapshots: 14,
            price_snapshots: 16,
            remote_token_snapshots: 14,
        });
    });

    it('carries the anchor archive fold-term heights', function () {
        const byKey = new Map(manifest.collectRows().rows);
        const key = 'anchor_archive_fold_term_activation.ANCHOR_ARCHIVE_FOLD_TERM_ACTIVATION';
        const row = byKey.get(key);
        assert.deepStrictEqual(row, { ...ProtocolChanges.get(key) });
        assert.strictEqual(Object.keys(row).length, 6);
        assertArmedHeightRow(row);
    });

    it('carries the nested EXECUTE gas-sum height row, armed on regtest and at the v0.24.0 testnet heights', function () {
        const key = 'nested_execute_gas_sum_activation.NESTED_EXECUTE_GAS_SUM_ACTIVATION';
        // Resolved through the manifest entry itself, so the case does not depend on
        // the VM mirror rows collectRows() also loads.
        const entry = manifest.ENTRIES.find((e) => e[0] === key);
        assert.ok(entry, 'the manifest lists the row');
        const row = entry[1]();
        assert.deepStrictEqual(row, { ...ProtocolChanges.get(key) });
        assert.deepStrictEqual(Object.keys(row).sort(),
            ['BTC:mainnet', 'BTC:testnet', 'DOGE:mainnet', 'DOGE:testnet', 'LTC:mainnet', 'LTC:testnet', 'regtest', 'testnet']);
        assert.strictEqual(row.regtest, 0);
        // The v0.24.0 cut arms the three per-chain testnet keys; mainnet and the bare testnet key stay unarmed.
        const ARMED = { 'BTC:testnet': 156908, 'LTC:testnet': 4927400, 'DOGE:testnet': 68005165 };
        for (const k of Object.keys(row)) if (k !== 'regtest') assert.strictEqual(row[k], ARMED[k] || ProtocolChanges.UNARMED, k);
        assert.strictEqual(ProtocolChanges.registry.unitOf(key), 'height');
        // The fingerprint covers the row: collectRows() is the production armed map, so the
        // gate has to be in it and its digest has to come out of the fingerprint of that map.
        const { fingerprint } = require('../../../../src/consensus/armed_map/canonical.js');
        const collected = manifest.collectRows();
        assert.strictEqual(collected.ok, true, collected.reason);
        const collectedRow = new Map(collected.rows).get(key);
        assert.ok(collectedRow, 'collectRows() carries the gate in the production armed map');
        assert.deepStrictEqual(collectedRow, row);
        const full = fingerprint(collected.rows);
        assert.match(full.rows[key], /^[0-9a-f]{64}$/);
        const armed = collected.rows.map(([k, v]) => (k === key ? [k, { ...v, regtest: 1 }] : [k, v]));
        const moved = fingerprint(armed);
        assert.notStrictEqual(moved.rows[key], full.rows[key], 'arming the row moves its digest');
        assert.notStrictEqual(moved.hex, full.hex, 'and the whole-map fingerprint');
        const dropped = fingerprint(collected.rows.filter(([k]) => k !== key));
        assert.ok(!(key in dropped.rows), 'omitting the gate removes its digest');
    });

    it('carries the per-chain LIST owner testnet heights', function () {
        const byKey = new Map(manifest.collectRows().rows);
        assert.deepStrictEqual(byKey.get('list_owner_activation.LIST_OWNER_ACTIVATION'), {
            mainnet: 0,
            'BTC:testnet': 155001,
            'LTC:testnet': 4906040,
            'DOGE:testnet': 67962387,
            testnet: 9999999999,
            regtest: 0,
        });
    });

    it('appends the VM mirror rows with the VM values', function () {
        const vm = require('xchain-vm');
        const res = manifest.collectRows();
        assert.strictEqual(res.ok, true, res.reason);
        const byKey = new Map(res.rows);
        for (const name of manifest.VM_EXPORT_NAMES) {
            assert.ok(byKey.has('xchain-vm.' + name), name);
            assert.strictEqual(canonicalValue(byKey.get('xchain-vm.' + name)), canonicalValue(vm[name]), name);
        }
        const accessors = require('xchain-vm/src/readonly-accessors.js');
        for (const name of manifest.VM_ACCESSORS_EXPORT_NAMES) {
            assert.strictEqual(canonicalValue(byKey.get('xchain-vm.' + name)), canonicalValue(accessors[name]), name);
        }
    });

    it('passes regtest through the indexer execution path and activates the JSON.stringify value-hook fix', async function () {
        const XChainVM = require('xchain-vm');
        const { runVmExecution } = require('../../../../src/actions/execute/run_vm.js');
        assert.strictEqual(XChainVM.JSON_STRINGIFY_HOOK_ACTIVATION.regtest, 0);
        const timestamp = XChainVM.BINARY_ALLOC_GATE_BLOCK_TIME + 1;
        assert.ok(timestamp < XChainVM.JSON_STRINGIFY_HOOK_ACTIVATION.mainnet);
        const vm = new XChainVM({
            execution: 'in-process',
            gasSchedule: {
                VM_COMPUTATION: 1,
                VM_STATE_READ: 100,
                VM_STATE_WRITE: 200,
                VM_STATE_DELETE: 100,
                VM_ORACLE_READ: 100,
                VM_CROSSCHAIN_READ: 100,
                VM_ATTEST_REQUEST: 5000,
                VM_EMISSION: 500,
                VM_XCALL_REQUEST: 2000,
                VM_XCALL_CALLBACK: 20000,
            },
            gasCeiling: 1000000,
        });
        const indexerDb = {
            getContractState: async () => ({}),
            getOracleDataForVM: async () => ({}),
            getCrossChainDataForVM: async () => ({}),
            getPollResultsForVM: async () => ({}),
            getContractStakeDataForVM: async () => ({}),
            createSavepoint: async (name) => name,
            releaseSavepoint: async () => {},
        };
        const handler = {
            config: { NETWORK: 'regtest', CHAIN: 'BTC', COIN: 'BTC' },
            actions: {
                vm,
                protocolChanges: { isEnabled: async () => false },
            },
            indexerDb,
            providerDeadlineWindows: null,
        };
        const ctx = {
            error: null,
            gasCost: 0,
            contractInfo: {
                code: 'module.exports=function(){var reads=0;var value={get x(){reads++;return reads===1?{armed:true}:{armed:false};}};return JSON.stringify(value);};',
            },
            data: {
                METHOD: 'default',
                SOURCE: 'regtest-probe',
                CONTRACT_ACTION_INDEX: 1,
                ACTION_INDEX: 1,
                TX_HASH: 'regtest-hook-probe-tx',
                TX_VOUT: 0,
                BLOCK_INDEX: 1,
                BLOCK_TIME: timestamp,
            },
        };
        vm.beginBlock();
        try {
            await runVmExecution.call(handler, ctx, { GAS_CEILING: 1000000 });
            assert.strictEqual(ctx.vmError, null);
            assert.strictEqual(JSON.parse(ctx.vmReturnValue), '{"x":{"armed":true}}');
        } finally {
            vm.endBlock();
            await vm.shutdown();
        }
    });

    it('turns a resolver that throws into ok:false naming the key', function () {
        const saved = manifest.ENTRIES[3];
        manifest.ENTRIES[3] = [saved[0], () => { throw new Error('boom'); }];
        try {
            const res = manifest.collectRows();
            assert.strictEqual(res.ok, false);
            assert.ok(res.reason.startsWith(saved[0] + ': boom'), res.reason);
        } finally {
            manifest.ENTRIES[3] = saved;
        }
    });

    it('turns a refused value into ok:false naming the key', function () {
        const saved = manifest.ENTRIES[5];
        manifest.ENTRIES[5] = [saved[0], () => ({ mainnet: () => 1 })];
        try {
            const res = manifest.collectRows();
            assert.strictEqual(res.ok, false);
            assert.ok(res.reason.startsWith(saved[0] + ': '), res.reason);
        } finally {
            manifest.ENTRIES[5] = saved;
        }
    });
});

describe('armed_map/manifest: the registry part files', function () {
    it('every row part file writes addGate() calls at column zero and holds at most 400 lines', function () {
        const parts = fs.readdirSync(PARTS).filter((f) => /^(shared_rows_\d+|gates_\d+|gates_flag_times)\.js$/.test(f)).sort();
        assert.ok(parts.length >= 8, parts.join(','));
        for (const f of parts) {
            const text = fs.readFileSync(path.join(PARTS, f), 'utf8');
            assert.ok(text.split('\n').length <= 401, f + ' is over 400 lines');
            assert.ok(/^addGate\('/m.test(text), f + ' registers nothing');
            assert.ok(!/^[ \t]+addGate\(/m.test(text), f + ' indents an addGate call');
        }
    });
});

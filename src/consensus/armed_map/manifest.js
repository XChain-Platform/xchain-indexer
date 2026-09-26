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
 * Armed-map fingerprint v2: the indexer's row manifest.
 *
 * THE MEANING, NOT THE LAYOUT. v2 hashes (key, value) rows. The rows are the
 * activation registry's own row list, rows() in src/protocol_changes.js: every
 * gate table, constant and ProtocolChanges time-table entry the running
 * process applies, under the literal `<stem>.<EXPORT>` key it has always had
 * (the knownGateKeys() spelling in consensus_rules_digest.js). A key is data,
 * not a path, so a module can move without a row moving and the fingerprint
 * stays.
 *
 * MEMBERSHIP IS THE REGISTRY, NEVER A DIRECTORY LISTING. Nothing here calls
 * readdirSync, and nothing here lists modules any more: a table that is not
 * a registry row is not applied by any module either, because every module
 * reads its table back from the registry. The enforcement is still a test
 * (test/unit/consensus/armed_map/manifest.test.js): it scans src/ for a map
 * declared outside the registry's part files and fails on any hit.
 *
 * THE TWELVE VM MIRROR ROWS are the one thing beside the registry: the bundled
 * xchain-vm resolves its own gate heights and instants inside this process, so
 * they are read from the loaded module, as `xchain-vm.<EXPORT>`, and a vm that
 * does not load poisons the fingerprint rather than dropping out of it.
 *
 ********************************************************************/

'use strict';

const { canonicalValue } = require('./canonical.js');
const { rows } = require('../../protocol_changes.js');

// Read the bundled VM once at manifest load, but defer a load failure until its
// mirror rows resolve so collectRows() can return the standard poisoned shape.
let VM_MODULE;
let VM_LOAD_ERROR;
try {
    VM_MODULE = require('xchain-vm');
} catch (e) {
    VM_LOAD_ERROR = e;
}

const VM_EXPORT_NAMES = [
    'PKG3_SANDBOX_ACTIVATION',
    'EXEC_LINT_ACTIVATION',
    'LINT_GLOBAL_ALIAS_ACTIVATION',
    'BINARY_ALLOC_GATE_BLOCK_TIME',
    'ASYNC_SURFACE_GATE_BLOCK_TIME',
    'STATE_KEY_NUL_GATE_BLOCK_TIME',
    'METERING_EVAL_ORDER_GATE_BLOCK_TIME',
    'CALL_SPREAD_METER_GATE_BLOCK_TIME',
    'REST_PATTERN_METER_GATE_BLOCK_TIME',
    'STATE_KEY_TYPE_GATE_BLOCK_TIME',
    'VM_LINT_HARDENING_GATE_BLOCK_TIME',
    'JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME',
];

// Reads one own property, refusing a missing one outright: an absent export
// read as undefined would say "renamed away" in a way nobody sees.
function ownValue(holder, name, where) {
    if (!Object.prototype.hasOwnProperty.call(holder, name)) {
        throw new Error(where + ' has no ' + name);
    }
    return holder[name];
}

function vmValue(name) {
    if (VM_LOAD_ERROR) throw VM_LOAD_ERROR;
    return ownValue(VM_MODULE, name, 'xchain-vm');
}

function buildEntries() {
    const entries = rows().map(([key, value]) => [key, () => value]);
    // Mirror the VM-resolved values because the VM enforces them inside this
    // process independently of the indexer's local activation twins.
    for (const name of VM_EXPORT_NAMES) {
        entries.push(['xchain-vm.' + name, () => vmValue(name)]);
    }
    return entries;
}

// [key, resolver]; each resolver returns the value the running process resolved.
const ENTRIES = buildEntries();

/**
 * Runs every resolver and checks every value is serialisable.
 * @returns {{ok: true, rows: Array<[string, *]>}|{ok: false, reason: string}}
 */
function collectRows() {
    const out = [];
    for (const [key, resolve] of ENTRIES) {
        let value;
        try {
            value = resolve();
            canonicalValue(value);
        } catch (e) {
            return { ok: false, reason: key + ': ' + (e && e.message ? e.message : String(e)) };
        }
        out.push([key, value]);
    }
    return { ok: true, rows: out };
}

module.exports = { ENTRIES, VM_EXPORT_NAMES, collectRows };

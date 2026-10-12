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
 ********************************************************************/

'use strict';

const assert = require('assert');

const XChainVM = require('xchain-vm');
const manifest = require('../../../../src/consensus/armed_map/manifest.js');
const ProtocolChanges = require('../../../../src/protocol_changes.js');

const VM_GATE_NAME = /(?:_ACTIVATION|_GATE_BLOCK_TIME)$/;

const ALIASES = {
    JSON_STRINGIFY_HOOK_GATE_BLOCK_TIME: 'JSON_STRINGIFY_HOOK_ACTIVATION',
};

const REGISTRY_TWINS = {
    BIGINT_SURFACE_STRIP_ACTIVATION: 'bigint_surface_strip_heights.BIGINT_SURFACE_STRIP_ACTIVATION',
    LINT_BANNED_WITH_ACTIVATION: 'vm_lint_banned_with_heights.VM_LINT_BANNED_WITH_ACTIVATION',
    LINT_DESTRUCTURE_ACTIVATION: 'vm_lint_destructure_heights.VM_LINT_DESTRUCTURE_ACTIVATION',
    LINT_OPTIONAL_CHAIN_ACTIVATION: 'vm_lint_optional_chain_heights.VM_LINT_OPTIONAL_CHAIN_ACTIVATION',
};

const KNOWN_GAPS = {};

function vmGateExportNames(holder) {
    const names = new Set();
    const seen = new Set();
    for (let current = holder; current && !seen.has(current); current = Object.getPrototypeOf(current)) {
        seen.add(current);
        for (const name of Object.getOwnPropertyNames(current)) {
            if (VM_GATE_NAME.test(name)) names.add(name);
        }
    }
    return [...names].sort();
}

function armedMapKeys() {
    return new Set(manifest.ENTRIES.map(([key]) => key));
}

describe('armed_map/vm_gate_coverage: every public VM gate is classified', function () {

    it('walks own and prototype statics', function () {
        const parent = Object.create(null, {
            PROTOTYPE_ACTIVATION: { value: Object.freeze({ regtest: 0 }) },
        });
        const child = Object.create(parent, {
            OWN_GATE_BLOCK_TIME: { value: 1, enumerable: true },
            NOT_A_GATE: { value: 2 },
        });
        assert.deepStrictEqual(vmGateExportNames(child),
            ['OWN_GATE_BLOCK_TIME', 'PROTOTYPE_ACTIVATION']);
    });

    it('classifies every exported activation and gate time exactly once', function () {
        const classified = manifest.VM_EXPORT_NAMES
            .concat(Object.keys(ALIASES), Object.keys(REGISTRY_TWINS), Object.keys(KNOWN_GAPS));
        assert.strictEqual(new Set(classified).size, classified.length,
            'a VM gate has more than one armed-map coverage classification');
        assert.deepStrictEqual(classified.slice().sort(), vmGateExportNames(XChainVM),
            'an xchain-vm gate export is unclassified, or a stale classification remains');
    });

    it('pins every direct mirror as an xchain-vm armed-map row', function () {
        const keys = armedMapKeys();
        for (const name of manifest.VM_EXPORT_NAMES) {
            assert.ok(keys.has('xchain-vm.' + name), name + ' has no xchain-vm armed-map row');
        }
    });

    it('pins every alias through its canonical VM mirror', function () {
        const keys = armedMapKeys();
        for (const [name, target] of Object.entries(ALIASES)) {
            assert.ok(keys.has('xchain-vm.' + target), name + ' aliases an unpinned VM export ' + target);
            assert.strictEqual(XChainVM[name], XChainVM[target].mainnet,
                name + ' no longer aliases the mainnet value of ' + target);
        }
    });

    it('pins every registry twin in the armed-map manifest', function () {
        const keys = armedMapKeys();
        for (const [name, key] of Object.entries(REGISTRY_TWINS)) {
            assert.ok(XChainVM[name], 'xchain-vm no longer exports ' + name);
            assert.ok(ProtocolChanges.get(key), name + ' names a missing registry twin ' + key);
            assert.ok(keys.has(key), name + ' registry twin is absent from the armed-map manifest');
        }
    });

    it('requires every known gap to state why it is not pinned', function () {
        for (const [name, reason] of Object.entries(KNOWN_GAPS)) {
            assert.ok(vmGateExportNames(XChainVM).includes(name), name + ' is a stale known gap');
            assert.ok(typeof reason === 'string' && reason.trim().length > 0,
                name + ' known gap has no reason');
        }
    });

});

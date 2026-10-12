/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The activation maps whose regtest leg is read from the environment, so only their
 * mainnet and testnet heights are held value-identical to the canonical constants.js.
 * A whole-map compare would tie the suite to process env and require order; the live
 * networks are where a one-sided edit forks the fleet.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const registry = require('../../../../src/protocol_changes.js');
const { modulePathFor } = require('../../../helpers/gate_modules.js');
const { canonExists, loadCanon } = require('./helpers/canon_source.js');

// registry stem -> the named export it and constants.js share; activation_gate_list.test.js
// reads these rows as pinned, so a stem listed here may not also claim it has no canonical map.
const LIVE_NETWORK_GATES = [
    ['rollcall_activation',       'ROLLCALL_ACTIVATION'],
    ['rollcall_gates_activation', 'ROLLCALL_GATES_ACTIVATION'],
];
const LIVE_NETWORKS = ['mainnet', 'testnet'];

function moduleExport(stem, exportName) {
    return require(modulePathFor(stem))[exportName];
}

let canon = null;
describe('activation-gate constant parity to canonical constants.js @regression', function () {
    before(function () { canon = loadCanon(); });

    // Run the floor without the docs sibling, so a renamed module or export fails here
    // even while the parity cases below are pending.
    it('resolves every live-network gate from its module and its registry row, whatever the checkout state', function () {
        for (const [stem, exportName] of LIVE_NETWORK_GATES) {
            const local = moduleExport(stem, exportName);
            const row = registry.get(stem + '.' + exportName);
            assert.ok(local && typeof local === 'object', stem + ' no longer exports the ' + exportName + ' map');
            for (const net of LIVE_NETWORKS)
                assert.strictEqual(local[net], row[net], stem + '.' + exportName + '.' + net + ': the module export is not the registry row');
        }
    });

    LIVE_NETWORK_GATES.forEach(function ([stem, exportName]) {
        const title = stem + ' ' + exportName + '.{mainnet,testnet} are value-identical to xchain-documentation/protocol/constants.js';
        (canonExists ? it : it.skip)(title, function () {
            const local = moduleExport(stem, exportName);
            const row = registry.get(stem + '.' + exportName);
            assert.ok(canon[exportName] && typeof canon[exportName] === 'object', exportName + ' must be a map in constants.js');
            for (const net of LIVE_NETWORKS) {
                assert.ok(net in canon[exportName], exportName + '.' + net + ' must be declared in constants.js');
                assert.strictEqual(row[net], canon[exportName][net],
                    stem + '.' + exportName + '.' + net + ' has drifted from the canonical constants.js; a one-sided flag-day edit forks consensus at the boundary');
                assert.strictEqual(local[net], canon[exportName][net],
                    stem + ' module ' + exportName + '.' + net + ' has drifted from the canonical constants.js');
            }
        });
    });
});

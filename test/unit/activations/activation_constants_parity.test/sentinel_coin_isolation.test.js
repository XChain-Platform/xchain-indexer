/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const registry = require('../../../../src/protocol_changes.js');

function registryKey(file, exportName) { return file.replace(/\.js$/, '') + '.' + exportName; }

describe('activation-gate constant parity to canonical constants.js @regression', function () {
    // Both admission maps are coin-keyed. During a staged arm one chain can be live while a
    // sibling's own slot is still a sentinel, and that declared slot must win over every other
    // chain's height. Drive both sentinel spellings against an isolated production registry so
    // this case cannot mutate the canonical rows used by the parity cases.
    it('keeps each admission map inert for a sentinel coin while a sibling coin is armed', function () {
        const sentinels = [
            ['null', registry.UNPINNED],
            ['far-future', registry.UNARMED],
        ];
        for (const exportName of ['MIRROR_ADMISSION_ACTIVATION', 'MIRROR_ADMISSION_CONSUMER_ACTIVATION']) {
            const key = registryKey('mirror_admission_activation.js', exportName);
            for (const [label, sentinel] of sentinels) {
                const isolated = new registry.registry.constructor();
                isolated.addGate(key, 'height', {
                    'BTC:testnet': 100,
                    'LTC:testnet': sentinel,
                });
                assert.strictEqual(isolated.activeAt(key, 'testnet', 'BTC', 150), true,
                    exportName + ': the armed sibling must be active in the ' + label + ' fixture');
                assert.strictEqual(isolated.activeAt(key, 'testnet', 'LTC', 150), false,
                    exportName + ': a ' + label + ' slot must not inherit the sibling chain height');
            }
        }
    });
});

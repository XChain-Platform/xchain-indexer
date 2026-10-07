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
 * test/unit/activations/anchor_reward_null_threshold.test.js
 *
 * An UNPINNED (null) threshold must read as inert. In JavaScript `0 >= null`
 * is true, so a bare comparison would arm the reward gates at height 0 on a
 * network that was never meant to carry the rule.
 */

'use strict';

const assert = require('assert');
const gate = require('../../../src/consensus/gates/anchor_reward_gate');

const NET = 'regtest';

describe('anchor reward gates treat an UNPINNED threshold as inert @regression @tier2', function () {
    const cases = [
        ['isAnchorRewardActive', 'ANCHOR_REWARD_ACTIVATION'],
        ['isArchiveRewardActive', 'ARCHIVE_REWARD_ACTIVATION'],
    ];

    for (const [fn, mapName] of cases) {
        describe(fn, function () {
            let saved;
            beforeEach(function () { saved = gate[mapName][NET]; });
            afterEach(function () { gate[mapName][NET] = saved; });

            it('is off at every height when the threshold is null', function () {
                gate[mapName][NET] = null;
                for (const h of [0, 1, 961000, '0', Number.MAX_SAFE_INTEGER]) {
                    assert.strictEqual(gate[fn](h, NET), false, 'height ' + h);
                }
            });

            it('is off for an unknown network', function () {
                assert.strictEqual(gate[fn](0, 'nonet'), false);
            });

            it('still arms at and above a finite threshold', function () {
                gate[mapName][NET] = 100;
                assert.strictEqual(gate[fn](99, NET), false);
                assert.strictEqual(gate[fn](100, NET), true);
                gate[mapName][NET] = 0;
                assert.strictEqual(gate[fn](0, NET), true);
            });

            it('is off for an unparseable height', function () {
                gate[mapName][NET] = 0;
                assert.strictEqual(gate[fn]('x', NET), false);
            });
        });
    }
});

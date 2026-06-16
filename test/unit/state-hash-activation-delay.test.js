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
 * test/unit/state-hash-activation-delay.test.js
 *
 * Regression guard for the per-block state_hash source caller (db.js).
 *
 * The state_hash SOURCE computation must resolve ACTIVATION_DELAY_BLOCKS the
 * same way every other reader does: nested under config['STAKING'], NOT from a
 * (never-assigned) top-level config key. Reading the top-level key returned
 * undefined, so the source skipped the entire deactivation_block class while the
 * xchain-sync follower (which uses the frozen per-coin constant) included it,
 * forcing a guaranteed state-hash-divergence HALT on the first deactivation
 * block and silently dropping the feature's primary protected row class.
 *
 * The golden StateHash leaf test drives a fixture-supplied activation_delay and
 * is therefore blind to this; these assertions pin the SOURCE config resolution.
 ********************************************************************/

'use strict';

const assert = require('assert');

// Frozen per-coin ACTIVATION_DELAY_BLOCKS. MUST equal
// xchain-sync/src/consensus-constants.js ACTIVATION_DELAY_BLOCKS_BY_COIN: the
// source (indexer) and follower (sync) hash the deactivation class with the
// SAME delay or replication halts. (Documented twin; kept here so the indexer
// suite has no cross-repo require.)
const EXPECTED_DELAY_BY_COIN = { BTC: 6, LTC: 24, DOGE: 60 };

// The exact nested-first resolution the db.js state_hash source caller uses
// (mirrors delegate.js/stake.js/unstake.js/rollback.js). Kept in lockstep with
// db.js so a regression to the top-level read is caught here.
function resolveActivationDelay(config) {
    let staking = config['STAKING'];
    return (staking && staking['ACTIVATION_DELAY_BLOCKS']) ? staking['ACTIVATION_DELAY_BLOCKS'] : config['ACTIVATION_DELAY_BLOCKS'];
}

describe('state_hash source: ACTIVATION_DELAY_BLOCKS resolution', function () {

    for (const coin of ['BTC', 'LTC', 'DOGE']) {
        const cfg = require('../../src/configs/' + coin + '.js').getConfig('mainnet');

        it(coin + ': the top-level ACTIVATION_DELAY_BLOCKS key is unset (the bug precondition)', function () {
            // If this ever becomes defined, the regression guard below is moot, but the
            // canonical location is STAKING.ACTIVATION_DELAY_BLOCKS; assert the source of truth.
            assert.strictEqual(cfg['ACTIVATION_DELAY_BLOCKS'], undefined,
                'top-level ACTIVATION_DELAY_BLOCKS must remain unset; the value lives under STAKING');
        });

        it(coin + ': STAKING.ACTIVATION_DELAY_BLOCKS equals the frozen per-coin constant', function () {
            assert.ok(cfg['STAKING'], coin + ' config must carry a STAKING block');
            assert.strictEqual(cfg['STAKING']['ACTIVATION_DELAY_BLOCKS'], EXPECTED_DELAY_BY_COIN[coin]);
        });

        it(coin + ': the source resolves a NON-NULL delay matching the follower constant', function () {
            const delay = resolveActivationDelay(cfg);
            assert.notStrictEqual(delay, undefined, 'source must not resolve undefined (would skip the deactivation class)');
            assert.notStrictEqual(delay, null, 'source must not resolve null (would skip the deactivation class)');
            assert.strictEqual(Number(delay), EXPECTED_DELAY_BY_COIN[coin],
                'source delay must equal the xchain-sync follower frozen constant, or the follower halts on divergence');
        });
    }
});

/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
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
 * The match barrier's content shortcut subtracts each match's relay margin from its
 * effective_time, so the indexer's margin table must be the hub's: a hub floor larger
 * than the indexer's copy overstates how far the hub's finalization order is local and
 * opens the barrier over a missing match. This compares the two tables against the
 * sibling xchain-hub checkout.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const path   = require('path');
const { siblingCheckout, skipOrFail } = require('../../../../helpers/sibling_checkout.js');
const { RELAY_MARGIN_FLOOR_S, RELAY_MARGIN_MAX_S, MATCH_FINALIZED_AT_SQL } =
    require('../../../../../src/hub/hub_db_sync/barriers/relay_margin.js');

const HUB_RELAY_MARGIN = '../../../../../../xchain-hub/src/lib/relay_margin.js';

function hubRelayMargin(ctx) {
    const verdict = siblingCheckout(__dirname, HUB_RELAY_MARGIN);
    if (!skipOrFail(ctx, verdict, 'relay margin hub parity')) return null;
    return require(path.resolve(__dirname, HUB_RELAY_MARGIN));
}

describe('relay margin table: indexer barrier copy against the hub @regression @tier1', function () {
    it('names the same chains as the hub, with the same floor for each', function () {
        const hub = hubRelayMargin(this);
        assert.deepStrictEqual(Object.keys(RELAY_MARGIN_FLOOR_S).sort(), Object.keys(hub.NOMINAL_BLOCK_INTERVAL_S).sort(),
            'a chain the hub stamps for must have a floor here');
        for (const chain of ['BTC', 'LTC', 'DOGE'])
            assert.strictEqual(RELAY_MARGIN_FLOOR_S[chain], hub.relayMarginFloorS(chain), chain + ' floor differs from the hub');
    });

    it('carries the hub cap', function () {
        const hub = hubRelayMargin(this);
        assert.strictEqual(RELAY_MARGIN_MAX_S, hub.RELAY_MARGIN_MAX_S);
    });

    it('takes the cap for an unknown chain where the hub falls back to the BTC floor', function () {
        // The one deliberate divergence. The hub stamps an unknown chain with the BTC
        // interval (2400 s); the indexer subtracts the cap (3000 s) instead. Subtracting
        // MORE than the hub added understates the stamp second, which can only keep the
        // shortcut shut longer, never open it over a missing match: the conservative
        // direction for a table the indexer cannot prove complete.
        const hub = hubRelayMargin(this);
        assert.strictEqual(hub.relayMarginFloorS('UNKNOWN'), hub.relayMarginFloorS('BTC'));
        assert.ok(MATCH_FINALIZED_AT_SQL.includes(' ELSE ' + RELAY_MARGIN_MAX_S + ' END'),
            'an unknown leg must take the cap in the coverage statement');
        assert.ok(RELAY_MARGIN_MAX_S >= hub.relayMarginFloorS('UNKNOWN'),
            'the unknown-chain margin must never be below what the hub stamps');
    });
});

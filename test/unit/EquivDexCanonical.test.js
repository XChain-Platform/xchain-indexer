'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// EQUIV header (WI-2 bump 2): cross-chain DEX (XDEX) round-trip.
// CONSENSUS-CRITICAL: the XMATCH canonical is rebuilt by the hub
// (CrossChainDexEngine._canonicalMatch, with the live pending.view) and the
// indexer/archive twins (cross_settle / StateAnchorPublisher / recovery, with the
// persisted finalizing_view). DEX is view-bearing: putting <view> in the EQUIV
// header is the R-3 defense: a legitimate view change re-signs the SAME content
// at a HIGHER view, so its bytes (and equivocation key) differ from the prior
// view's, distinguishing it from a true double-sign.
const assert = require('assert');
const eq = require('../../src/equivocation_header.js');
const Cross_Settle = require('../../src/actions/cross_settle.js');

const settle = new Cross_Settle({ config: {}, decoderDb: null, indexerDb: null, util: null, mapper: null });

function rowAt(network, snapshotBlock, view){
    return { match_id:'abc', snapshot_block:snapshotBlock, network:network,
        a_chain:'DOGE', a_action_index:7, a_tick:'DOGT', a_amount:'20', a_ownership:0, a_payout_addr:'Laddr',
        b_chain:'LTC', b_action_index:1, b_tick:'LTCT', b_amount:'40', b_ownership:0, b_payout_addr:'Daddr',
        effective_time:1700000000, a_kind:'order', a_filled_before:'0', b_kind:'order', b_filled_before:'40',
        finalizing_view:view };
}
const RAW = 'XMATCH|abc|100|DOGE|7|DOGT|20|0|Laddr|LTC|1|LTCT|40|0|Daddr|1700000000|regtest|order|0|order|40';

describe('EQUIV DEX canonical (WI-2 bump 2)', function () {

    it('below the flag-day (mainnet) → bare XMATCH bytes (regression-safe)', function () {
        const m = rowAt('mainnet', 5, 0);
        const raw = RAW.replace('|regtest|', '|mainnet|').replace('|100|', '|5|');
        assert.strictEqual(settle._canonical(m), raw);
    });

    it('at/above the flag-day (regtest) → header-wrapped with VIEW=finalizing_view', function () {
        assert.strictEqual(settle._canonical(rowAt('regtest', 100, 0)), 'EQUIV|XDEX|abc|0||' + RAW);
        assert.strictEqual(settle._canonical(rowAt('regtest', 100, 2)), 'EQUIV|XDEX|abc|2||' + RAW);
    });

    it('R-3: a higher finalizing_view yields DIFFERENT bytes + a different equivocation key', function () {
        const v0 = settle._canonical(rowAt('regtest', 100, 0));
        const v1 = settle._canonical(rowAt('regtest', 100, 1));
        assert.notStrictEqual(v0, v1);
        const keyOf = (c) => c.slice('EQUIV|'.length, c.indexOf('||'));
        assert.strictEqual(keyOf(v0), 'XDEX|abc|0');
        assert.strictEqual(keyOf(v1), 'XDEX|abc|1');   // same round, different view → not equivocation
    });

    it('matches buildEquivCanonical(XDEX, match_id, view, raw)', function () {
        const expected = eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, 'abc', 3, RAW);
        assert.strictEqual(settle._canonical(rowAt('regtest', 100, 3)), expected);
    });
});

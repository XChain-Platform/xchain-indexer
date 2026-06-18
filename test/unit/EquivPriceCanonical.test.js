'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// EQUIV header (WI-2 bump 2) - oracle/price (XORACLE) round-trip.
// CONSENSUS-CRITICAL: ed25519.buildPriceV0Payload is the on-chain verifier twin of
// the hub OracleConsensus / PriceAggregator builders. They MUST produce byte-identical
// bytes. XORACLE has no view change (VIEW=0); the gate keys on the round's BTC block
// HEIGHT (carried in the signed content AND the on-chain wire), so the hub + every
// indexer flip on the identical anchor every other engine uses (#4232).
const assert = require('assert');
const eq = require('../../src/equivocation_header.js');
const ed = require('../../src/ed25519.js');

// Deliberately unsorted input: the canonical sorts by pair, so output is deterministic.
const PAIRS = [{ pair:'LTC/USD', price:'10' }, { pair:'BTC/USD', price:'100' }];
const SORTED = [{ pair:'BTC/USD', price:'100' }, { pair:'LTC/USD', price:'10' }];
// round and btc_block_height are distinct fields now; the height is the gate input.
const rawAt = (round, height) => JSON.stringify({ round: round, timestamp: 1234, btc_block_height: height, pairs: SORTED });

describe('EQUIV price canonical (WI-2 bump 2)', function () {

    it('below the flag-day (mainnet) → bare JSON (regression-safe)', function () {
        // height 5 is below mainnet activation (999999999) → headerless
        assert.strictEqual(ed.buildPriceV0Payload(5, 1234, PAIRS, 'mainnet', 5), rawAt(5, 5));
    });

    it('at/above the flag-day (regtest) → header-wrapped (TAG=XORACLE, ROUND_ID=btc_height, VIEW=0)', function () {
        // regtest activation is 0; the ROUND_ID is the BTC block height, not the round counter.
        assert.strictEqual(ed.buildPriceV0Payload(42, 1234, PAIRS, 'regtest', 500),
            'EQUIV|XORACLE|500|0||' + rawAt(42, 500));
    });

    it('unknown network → OFF (bare JSON, safe default)', function () {
        assert.strictEqual(ed.buildPriceV0Payload(42, 1234, PAIRS, undefined, 500), rawAt(42, 500));
    });

    it('pairs sort deterministically regardless of input order', function () {
        const a = ed.buildPriceV0Payload(42, 1234, PAIRS, 'regtest', 500);
        const b = ed.buildPriceV0Payload(42, 1234, [...PAIRS].reverse(), 'regtest', 500);
        assert.strictEqual(a, b);
    });

    it('the EQUIV key is XORACLE|<btc_height>|0 (gate keys on the BTC block height, #4232)', function () {
        const canon = ed.buildPriceV0Payload(42, 1234, PAIRS, 'regtest', 777);
        assert.strictEqual(canon.slice('EQUIV|'.length, canon.indexOf('||')), 'XORACLE|777|0');
    });

    it('the EQUIV header gates on the BTC height, NOT the round counter (#4232)', function () {
        // round counter is huge (above mainnet activation) but the height is below it:
        // the header MUST stay OFF (gates on height). This is the exact #4232 fork the
        // fix forecloses (round-gated oracle would wrongly wrap here).
        const canon = ed.buildPriceV0Payload(1000000000, 1234, PAIRS, 'mainnet', 5);
        assert.strictEqual(canon, rawAt(1000000000, 5));
        // and the inverse: tiny round, height above the flag-day → header ON.
        const canon2 = ed.buildPriceV0Payload(1, 1234, PAIRS, 'mainnet', 999999999);
        assert.strictEqual(canon2.slice('EQUIV|'.length, canon2.indexOf('||')), 'XORACLE|999999999|0');
    });
});

'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// EQUIV header (WI-2 bump 2) — oracle/price (XORACLE) round-trip.
// CONSENSUS-CRITICAL: ed25519.buildPriceV0Payload is the on-chain verifier twin of
// the hub OracleConsensus / PriceAggregator builders. They MUST produce byte-identical
// bytes. XORACLE has no view change (VIEW=0); the gate keys on `round` (a BTC block
// height carried in the signed content) so the hub + every indexer flip identically.
const assert = require('assert');
const eq = require('../../src/equivocation_header.js');
const ed = require('../../src/ed25519.js');

// Deliberately unsorted input — the canonical sorts by pair, so output is deterministic.
const PAIRS = [{ pair:'LTC/USD', price:'10' }, { pair:'BTC/USD', price:'100' }];
const SORTED = [{ pair:'BTC/USD', price:'100' }, { pair:'LTC/USD', price:'10' }];
const rawAt = (round) => JSON.stringify({ round: round, timestamp: 1234, pairs: SORTED });

describe('EQUIV price canonical (WI-2 bump 2)', function () {

    it('below the flag-day (mainnet) → bare JSON (regression-safe)', function () {
        assert.strictEqual(ed.buildPriceV0Payload(5, 1234, PAIRS, 'mainnet'), rawAt(5));
    });

    it('at/above the flag-day (regtest) → header-wrapped (TAG=XORACLE, ROUND_ID=round, VIEW=0)', function () {
        assert.strictEqual(ed.buildPriceV0Payload(500, 1234, PAIRS, 'regtest'),
            'EQUIV|XORACLE|500|0||' + rawAt(500));
    });

    it('unknown network → OFF (bare JSON, safe default)', function () {
        assert.strictEqual(ed.buildPriceV0Payload(500, 1234, PAIRS, undefined), rawAt(500));
    });

    it('pairs sort deterministically regardless of input order', function () {
        const a = ed.buildPriceV0Payload(500, 1234, PAIRS, 'regtest');
        const b = ed.buildPriceV0Payload(500, 1234, [...PAIRS].reverse(), 'regtest');
        assert.strictEqual(a, b);
    });

    it('the EQUIV key is XORACLE|<round>|0 (round = the BTC block in the signed content)', function () {
        const canon = ed.buildPriceV0Payload(777, 1234, PAIRS, 'regtest');
        assert.strictEqual(canon.slice('EQUIV|'.length, canon.indexOf('||')), 'XORACLE|777|0');
    });
});

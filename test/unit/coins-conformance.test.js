'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Per-repo coin-registry conformance guard. The coin registry (BTC/LTC/DOGE +
// index.js + consensus_pin.js) is CONSENSUS-CRITICAL and vendored byte-identically
// from canonical xchain-hub/src/coins into 8 consumer repos. Until now the
// pin==consensusHash conformance test lived only in xchain-hub's suite and the
// byte-identity drift check only in the aggregate bin/ci-all.sh, so a
// consumer-only edit (coin file + consensus_pin.js changed together in one repo)
// passed that repo's own CI while forking from the canonical hub. This guard
// runs in THIS repo's own suite and asserts BOTH:
//   1. CONFORMANCE - the vendored pin equals the vendored files' consensusHash
//      (catches a pin/coin edit that was not made in lockstep).
//   2. IDENTITY    - every vendored file is byte-identical to the canonical
//      xchain-hub copy (catches any consumer-only edit, even a consistent one).
// When the sibling xchain-hub checkout is absent (standalone deploy), the
// identity tier skips rather than fails, matching ConsensusPrimitiveConformance;
// set XCHAIN_REQUIRE_SIBLINGS=1 in CI (with the sibling checked out, or
// XCHAIN_HUB_DIR pointed at it) so a missing sibling hard-fails instead of
// green-by-skip.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const coins = require('../../src/coins');
const { CONSENSUS_CONFIG_PIN } = require('../../src/coins/consensus_pin.js');

const LOCAL_COINS_DIR = path.join(__dirname, '..', '..', 'src', 'coins');
const HUB_DIR   = process.env.XCHAIN_HUB_DIR || path.join(__dirname, '..', '..', '..', 'xchain-hub');
const CANON_DIR = path.join(HUB_DIR, 'src', 'coins');
const CANON_PRESENT = fs.existsSync(CANON_DIR);
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

// Keep in lockstep with FILES in xchain-hub/bin/sync-coins.sh.
const VENDORED_FILES = ['BTC.js', 'LTC.js', 'DOGE.js', 'index.js', 'consensus_pin.js'];

describe('coin-registry conformance (vendored copy) @regression', function(){

    describe('pin == consensusHash over the vendored files', function(){
        for(const net of coins.NETWORKS){
            const pin = CONSENSUS_CONFIG_PIN[net];
            if(pin === null || pin === undefined) continue; // pre-arm (mainnet)
            for(const tick of coins.ALLOWED_COINS){
                if(!pin[tick]) continue; // freshly added chain, not yet pinned
                it(`${tick}/${net} vendored pin matches the vendored consensusHash`, function(){
                    assert.strictEqual(coins.consensusHash(tick, net), String(pin[tick]).toLowerCase());
                });
            }
        }
        it('verifyConsensusPin passes for every network on the vendored bundle', function(){
            for(const net of coins.NETWORKS) coins.verifyConsensusPin(net);
        });
    });

    describe('byte-identity to canonical xchain-hub/src/coins', function(){
        before(function(){
            if(!CANON_PRESENT){
                if(REQUIRE_SIBLINGS)
                    throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but canonical xchain-hub coins dir not found at ' + CANON_DIR);
                this.skip();
            }
        });

        VENDORED_FILES.forEach(function(f){
            it(f + ' is byte-identical to the canonical xchain-hub copy', function(){
                const local = fs.readFileSync(path.join(LOCAL_COINS_DIR, f), 'utf8');
                const canon = fs.readFileSync(path.join(CANON_DIR, f), 'utf8');
                assert.strictEqual(local, canon,
                    f + ' drifted from canonical xchain-hub/src/coins; run xchain-hub/bin/sync-coins.sh to resync');
            });
        });
    });
});

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/pushvalidatorrewards-retired.test.js
 *
 * CONSENSUS/SECURITY REGRESSION GUARD for the RETIRED validator-reward push rail.
 *
 * pushvalidatorrewards was a key-authenticated JSON-RPC that wrote rows into
 * validator_rewards, which COLLECT can spend. Every reward it carried is derived
 * from on-chain bytes instead: oracle_round / attest_fee / attest_bcast during
 * block processing, anchor_<CHAIN> and anchor_bundle from the ANCHOR bundle's
 * publisher attestation, anchor_archive from the archive head's. The method is
 * removed outright, handler and all: no hub build carries a push loop or the
 * terminal-refusal predicate any more, so there is no caller left to be kind to.
 *
 * What this file pins is that the rail does not come back by accident:
 *   - src/api.js declares no pushvalidatorrewards handler at all, so no request
 *     body can reach createValidatorReward or the smallest-pubkey
 *     reconcileAnchorRewardWinner collapse through an RPC;
 *   - WRITE_METHODS does not list it, so nothing re-registers it by leaning on
 *     the gate list as if the method still existed.
 *
 * The SHIPPED behaviour of the removal (ungated, and answered -32601 by the real
 * app over HTTP) is asserted in test/security/http-surface/auth-gate.test.js,
 * which boots src/api.js for real. These are the cheap source-shape guards.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

// api.js is a server entrypoint and exports no controller, so its shape is asserted
// the same way test/unit/api-federation-read-isolation.test.js asserts its apiView
// routing: over the source text.
const API_SRC = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');

// api.js documents its own history in prose, and the retired rail is named in
// several of those comments on purpose. A call-site assertion therefore has to
// read CODE, not narrative, or it fails on the very comment that records the
// retirement. Comments are stripped crudely (no string-literal awareness), which
// is safe here: the assertions below only ask whether an identifier survives.
const API_CODE = API_SRC
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');

describe('pushvalidatorrewards is retired outright @regression @tier1', function () {

    it('declares no handler in src/api.js', function () {
        assert.ok(!/\bpushvalidatorrewards\s*[(:]/i.test(API_CODE),
            'the retired rail must not be re-registered as a JSON-RPC method');
    });

    it('is not listed in WRITE_METHODS', function () {
        const m = /const WRITE_METHODS = new Set\(\[([^\]]*)\]\)/.exec(API_SRC);
        assert.ok(m, 'WRITE_METHODS declaration not found in src/api.js');
        assert.ok(!/pushvalidatorrewards/.test(m[1]),
            'a retired method left in the gate list implies a handler that no longer exists');
    });

    it('leaves the write-gate list in place so a future write method lands in it', function () {
        // The removal empties WRITE_METHODS; it must not delete the set, or the next
        // method that mutates replicated state ships ungated by default.
        assert.match(API_SRC, /const WRITE_METHODS = new Set\(/,
            'the write-gate list must survive the last member leaving it');
        assert.match(API_SRC, /WRITE_METHODS\.has\(normalized\)/,
            'the perimeter gate must still consult the write list');
    });

    it('holds no reward-write call site anywhere in the controller surface', function () {
        // The forge vector was an RPC body reaching either of these. The block-processing
        // derive path lives in XChainIndexer / actions, never in api.js.
        assert.ok(!/createValidatorReward\s*\(/.test(API_CODE),
            'no RPC handler may mint a COLLECT-spendable validator_rewards row');
        assert.ok(!/reconcileAnchorRewardWinner\s*\(/.test(API_CODE),
            'no RPC handler may run the collapse that DELETES a derived reward row');
    });
});

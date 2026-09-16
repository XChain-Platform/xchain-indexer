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
 *
 * attest_relay_activation twin parity.
 *
 * The hub decides WHEN to broadcast an ATTEST v3/v4 relay leg and the indexers
 * decide whether to ACCEPT one. If the two copies of the gate disagree, the hub
 * broadcasts legs the fleet rejects (dead relay) or, worse, some indexers accept
 * a leg others reject, which forks acceptance at the flag-day. This suite pins:
 *   1. the armed values and the gate predicate's behavior at the boundary, and
 *   2. byte-identity of the two source copies, which is what catches comment or
 *      logic drift that a values-only check would sail past.
 *
 * Mirrors anchor_reward_activation_parity.test.js, with one deliberate difference:
 * these twins carry NO per-file self-reference (the header names both copies),
 * so the byte comparison admits no exceptions at all.
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const indexer = require('../../../src/attest_relay_activation.js');
// Decides whether the hub twin may be trusted before the parity cases read it.
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const INDEXER_SRC = path.resolve(__dirname, '..', '..', '..', 'src', 'attest_relay_activation.js');
const HUB_SRC     = path.resolve(__dirname, '..', '..', '..', '..', 'xchain-hub', 'src', 'attest_relay_activation.js');

// A bare clone skips the twin half; a run that declared the sibling supplied
// (XCHAIN_REQUIRE_SIBLINGS=1, set by bin/ci-all.sh and the CI sibling jobs) fails it,
// since there an absent hub means a broken checkout and a skip would ship a drift green.
// A lane symlink into a live main checkout is refused like an absent hub.
function hubOrSkip(ctx) {
    const hubCheckout = siblingCheckout(__dirname, HUB_SRC);
    return skipOrFail(ctx, hubCheckout, 'the xchain-hub attest_relay_activation twin');
}

describe('attest_relay_activation twin parity @regression @tier1', function () {

    it('is armed on the ratified BTC anchor, genesis-on off mainnet', function () {
        assert.strictEqual(indexer.ATTEST_RELAY_ACTIVATION.mainnet, 963000);
        assert.strictEqual(indexer.ATTEST_RELAY_ACTIVATION.testnet, 0);
        assert.strictEqual(indexer.ATTEST_RELAY_ACTIVATION.regtest, 0);
    });

    it('is INERT below the anchor and live at it (the item ships gated)', function () {
        assert.strictEqual(indexer.isAttestRelayActive(962999, 'mainnet'), false);
        assert.strictEqual(indexer.isAttestRelayActive(963000, 'mainnet'), true);
        assert.strictEqual(indexer.isAttestRelayActive(963001, 'mainnet'), true);
    });

    it('fails closed on anything it cannot evaluate', function () {
        assert.strictEqual(indexer.isAttestRelayActive(5, 'bogusnet'), false);
        assert.strictEqual(indexer.isAttestRelayActive('not-a-number', 'mainnet'), false);
        assert.strictEqual(indexer.isAttestRelayActive(null, 'mainnet'), false);
        assert.strictEqual(indexer.isAttestRelayActive(undefined, 'mainnet'), false);
    });

    it('is active from genesis on the test networks so regtest exercises the relay', function () {
        assert.strictEqual(indexer.isAttestRelayActive(0, 'regtest'), true);
        assert.strictEqual(indexer.isAttestRelayActive(0, 'testnet'), true);
    });

    it('the hub copy is byte-identical to the indexer copy', function () {
        hubOrSkip(this);
        assert.strictEqual(fs.readFileSync(HUB_SRC, 'utf8'), fs.readFileSync(INDEXER_SRC, 'utf8'),
            'attest_relay_activation.js drifted between xchain-indexer and xchain-hub; ' +
            'a one-sided edit forks relay acceptance at the flag-day');
    });

    it('the hub copy exports the same map and predicate', function () {
        hubOrSkip(this);
        const hub = require(HUB_SRC);
        assert.deepStrictEqual(hub.ATTEST_RELAY_ACTIVATION, indexer.ATTEST_RELAY_ACTIVATION);
        for (const [block, network] of [[962999, 'mainnet'], [963000, 'mainnet'], [0, 'regtest'], [7, 'bogusnet']]) {
            assert.strictEqual(hub.isAttestRelayActive(block, network),
                indexer.isAttestRelayActive(block, network),
                'predicate disagreed at ' + network + ':' + block);
        }
    });
});

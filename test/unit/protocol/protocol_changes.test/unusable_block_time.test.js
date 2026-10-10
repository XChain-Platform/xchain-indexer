// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const ProtocolChanges = require('../../../../src/protocol_changes.js');
const { createMockIndexer } = require('../../../fixtures/mocks');

describe('ProtocolChanges unusable block_time @regression @tier3', function () {
    let indexer;
    let changes;

    beforeEach(function () {
        indexer = createMockIndexer();
        indexer.config.NETWORK = 'mainnet';
        changes = new ProtocolChanges(indexer, '0.2.0');
    });

    it('fails an armed finite time gate closed without throwing for unusable timestamps', async function () {
        const unusable = [false, null, undefined, NaN, Infinity, -Infinity, '', 'not-a-time', {}, Symbol('block_time')];

        for (const blockTime of unusable) {
            indexer.decoderDb.getBlockTime.resolves(blockTime);
            assert.strictEqual(await changes.isEnabled('CONTROLLER_GUARD', 100), false,
                String(blockTime) + ' must not activate the time gate');
        }
    });

    it('continues accepting finite numeric timestamps and numeric timestamp strings', async function () {
        const activation = changes.changes.CONTROLLER_GUARD.mainnet_time;

        for (const blockTime of [activation, String(activation)]) {
            indexer.decoderDb.getBlockTime.resolves(blockTime);
            assert.strictEqual(await changes.isEnabled('CONTROLLER_GUARD', 100), true);
        }
    });

    it('does not require a usable timestamp when the network time gate is at genesis', async function () {
        indexer.config.NETWORK = 'regtest';
        changes = new ProtocolChanges(indexer, '0.2.0');
        indexer.decoderDb.getBlockTime.resolves(false);

        assert.strictEqual(await changes.isEnabled('CONTROLLER_GUARD', 100), true);
    });
});

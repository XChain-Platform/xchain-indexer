// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'mainnet';

const assert = require('assert');
const { createBaseData } = require('../../../fixtures/mocks');
const { armAnchor, disarmAnchor, v1Params } = require('./anchor.test/helpers/anchor_fixtures.js');
const protocolChanges = require('../../../../src/protocol_changes.js');

const ANCHOR_ACTIVATION = protocolChanges.copy('anchor_activation.ANCHOR_ACTIVATION');

describe('Anchor v1 checkpoint sequence binding below gate @regression @tier3', function () {
    for (const network of ['mainnet', 'testnet']) {
        it('keeps a mismatched checkpoint sequence valid on ' + network, async function () {
            const armed = armAnchor();
            try {
                armed.indexer.config.NETWORK = network;
                const archiveJson = JSON.stringify({
                    v: 1,
                    network,
                    batch_seq: 0,
                    matches: [{ match_id: 'm1' }],
                    capability_snapshots: [],
                });
                const data = createBaseData({
                    ACTION: 'ANCHOR',
                    FORMAT: 1,
                    COIN: 'DOGE',
                    BLOCK_INDEX: ANCHOR_ACTIVATION[network] + 1,
                });

                await armed.handler.parse(v1Params(archiveJson, {
                    network,
                    seq: '961000',
                    snapshot: '100',
                }), data, null);

                assert.strictEqual(data.STATUS, 'valid');
                const checkpointCalls = armed.indexer.indexerDb.getMaxAnchorCheckpointSeq.getCalls();
                assert.strictEqual(checkpointCalls.length, 1);
                assert.strictEqual(checkpointCalls[0].args[0], 'BTC');
                assert.strictEqual(checkpointCalls[0].args[1], network);
                assert.ok(checkpointCalls[0].args.length < 3 || !checkpointCalls[0].args[2]);

                const watermarkCalls = armed.indexer.indexerDb.getArchiveReplayWatermarks.getCalls();
                assert.strictEqual(watermarkCalls.length, 1);
                assert.ok(watermarkCalls[0].args.length < 2 || !watermarkCalls[0].args[1]);
            } finally {
                disarmAnchor(armed);
            }
        });
    }
});

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
 * Unit: repeated block parse exceptions surface as a status wedge
 */

'use strict';

const assert = require('assert');

const blockParseMethods = require('../../../src/XChainIndexer/block_parse');
const blockCommitMethods = require('../../../src/XChainIndexer/block_commit');
const blockFaultMethods = require('../../../src/XChainIndexer/block_faults');
const stallHealth = require('../../../src/XChainIndexer/stall_health');
const { hubConfigStaleness } = require('../../../src/XChainIndexer/hub_config_poll');
const { statusVerdict, statusBody } = require('../../../src/api/status_route');

const STATUS_CONTRACT = Object.assign({ hubConfigStaleness }, stallHealth);
const WATCH_STATUS_FIELDS = [
    'indexerBlock',
    'inFlightBlock',
    'decoderBlock',
    'lag',
    'isSynced',
    'atProcessableTip',
    'stallReason',
    'stallClearsAt',
    'degraded',
    'waitingOnFutureBlock',
    'stallClass',
    'lastBlockCommittedAt',
    'pollSilent',
    'lastPollAt'
];

function makeIndexer(error) {
    let rollbacks = 0;
    let finalizeCalls = 0;
    const indexer = Object.assign({}, blockParseMethods, blockCommitMethods, blockFaultMethods, {
        config: { BLOCK_CHECK_INTERVAL: 6000 },
        stallReason: null,
        stallClearsAt: null,
        lastBlockCommittedAt: 1791417600000,
        lastPollAt: 1791417610000,
        healthStallGraceMs: 60000,
        lastHubConfigFetchAt: null,
        util: {
            withTimeout: promise => promise,
            logError: () => {}
        },
        indexerDb: {
            currentTxEpoch: () => 1,
            runInTxEpoch: (epoch, fn) => fn(),
            rollbackTransaction: async () => { rollbacks++; }
        },
        openBlockTransaction: async () => false,
        runBlockPasses: async function (blk) {
            return this.finalizeBlock(blk);
        },
        finalizeBlock: async () => {
            finalizeCalls++;
            throw error;
        },
        isSynced: () => false,
        isPollSilent: () => false
    });
    indexer.rollbackCount = () => rollbacks;
    indexer.finalizeCallCount = () => finalizeCalls;
    return indexer;
}

async function failBlock(indexer) {
    return indexer.processBlock({ blockToParse: 43, blockTime: 1, rawBlockTime: 1,
                                  blockTransactions: [] },
                                42, 43, null);
}

describe('repeated finalizeBlock exception status', function () {
    it('promotes the second consecutive finalizeBlock exception and keeps it latched', async function () {
        const failure = new Error('Cannot read properties of undefined');
        const indexer = makeIndexer(failure);

        const first = await failBlock(indexer);
        assert.strictEqual(first.committed, false);
        assert.strictEqual(first.stop, true);
        assert.strictEqual(indexer.finalizeCallCount(), 1);
        assert.strictEqual(indexer.stallReason, null,
            'one transient block failure must not be promoted to a stall');

        await failBlock(indexer);
        assert.strictEqual(indexer.finalizeCallCount(), 2);
        assert.strictEqual(indexer.rollbackCount(), 2);
        assert.strictEqual(indexer.stallReason, 'parse_exception: Cannot read properties of undefined');
        assert.strictEqual(indexer.stallClearsAt, null);

        await failBlock(indexer);
        assert.strictEqual(indexer.finalizeCallCount(), 3);
        assert.strictEqual(indexer.stallReason, 'parse_exception: Cannot read properties of undefined',
            'later identical retries must keep the confirmed failure latched');
    });

    it('emits the exact wedged status fixture covered by the xchain-watch critical rule', async function () {
        const indexer = makeIndexer(new Error('Cannot read properties of undefined'));
        await failBlock(indexer);
        await failBlock(indexer);

        const verdict = statusVerdict(STATUS_CONTRACT, indexer);
        assert.strictEqual(verdict.stalled, true);
        assert.strictEqual(verdict.wedged, true);
        assert.strictEqual(verdict.stallClass, 'wedged');

        const body = statusBody(STATUS_CONTRACT, indexer, {
            indexerBlock: 328013,
            inFlightBlock: null,
            decoderBlock: 328014,
            verdict,
            hubMirror: { configured: false }
        });
        const watchStatus = Object.fromEntries(WATCH_STATUS_FIELDS.map(key => [key, body[key]]));
        assert.deepStrictEqual(watchStatus, {
            indexerBlock: 328013,
            inFlightBlock: null,
            decoderBlock: 328014,
            lag: 1,
            isSynced: false,
            atProcessableTip: false,
            stallReason: 'parse_exception: Cannot read properties of undefined',
            stallClearsAt: null,
            degraded: false,
            waitingOnFutureBlock: false,
            stallClass: 'wedged',
            lastBlockCommittedAt: 1791417600000,
            pollSilent: false,
            lastPollAt: 1791417610000
        });
    });
});

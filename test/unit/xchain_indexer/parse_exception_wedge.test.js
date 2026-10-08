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

const XChainIndexer    = require('../../../src/XChainIndexer');
const blockParseMethods = require('../../../src/XChainIndexer/block_parse');
const blockCommitMethods = require('../../../src/XChainIndexer/block_commit');
const blockFaultMethods = require('../../../src/XChainIndexer/block_faults');
const { statusVerdict, statusBody } = require('../../../src/api/status_route');

function makeIndexer(error) {
    let rollbacks = 0;
    const indexer = Object.assign({}, blockParseMethods, blockCommitMethods, blockFaultMethods, {
        config: {},
        stallReason: null,
        stallClearsAt: null,
        lastBlockCommittedAt: Date.now() - 600000,
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
        finalizeBlock: async () => { throw error; },
        isSynced: () => false,
        isPollSilent: () => false
    });
    indexer.rollbackCount = () => rollbacks;
    return indexer;
}

async function failBlock(indexer) {
    return indexer.processBlock({ blockToParse: 43, blockTime: 1, rawBlockTime: 1,
                                  blockTransactions: [] },
                                42, 43, null);
}

describe('repeated finalizeBlock exception status', function () {
    it('latches the repeated failure and reports it as a wedged status', async function () {
        const failure = new Error('supply sanity mismatch');
        const indexer = makeIndexer(failure);

        const first = await failBlock(indexer);
        assert.strictEqual(first.committed, false);
        assert.strictEqual(first.stop, true);
        assert.strictEqual(indexer.stallReason, null,
            'one transient block failure must not be promoted to a stall');

        await failBlock(indexer);
        assert.strictEqual(indexer.rollbackCount(), 2);
        assert.strictEqual(indexer.stallReason, 'parse_exception: supply sanity mismatch');
        assert.strictEqual(indexer.stallClearsAt, null);

        const verdict = statusVerdict(XChainIndexer, indexer);
        assert.strictEqual(verdict.stalled, true);
        assert.strictEqual(verdict.wedged, true);
        assert.strictEqual(verdict.stallClass, 'wedged');

        const body = statusBody(XChainIndexer, indexer, {
            indexerBlock: 42,
            inFlightBlock: null,
            decoderBlock: 43,
            verdict,
            hubMirror: { configured: false }
        });
        assert.strictEqual(body.stallReason, 'parse_exception: supply sanity mismatch');
        assert.strictEqual(body.stallClass, 'wedged');

        await failBlock(indexer);
        assert.strictEqual(indexer.stallReason, 'parse_exception: supply sanity mismatch',
            'later identical retries must keep the confirmed failure latched');
    });
});

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
 * Unit: /status publishes the train activation verdict
 */

'use strict';

const assert = require('assert');

const { buildHealthResponse } = require('../../../src/api/health');
const { statusBody } = require('../../../src/api/status_route');

function fakeIndexer(trainActivation){
    return {
        decoderDb: null,
        indexerDb: null,
        schemaReady: true,
        stallReason: null,
        stallClearsAt: null,
        lastBlockCommittedAt: null,
        lastPollAt: null,
        lastDecoderBlock: 100,
        isSynced: () => false,
        trainActivation
    };
}

function statusFor(indexer){
    return statusBody({ atProcessableTip: () => false }, indexer, {
        indexerBlock: null,
        inFlightBlock: null,
        decoderBlock: null,
        verdict: {
            now: 1,
            stalled: false,
            wedged: false,
            futureWait: false,
            stallClass: 'none',
            lastHubConfigFetchAt: null,
            hubConfigAgeSeconds: null,
            hubConfigStale: false
        },
        hubMirror: { configured: false }
    });
}

async function healthFor(indexer){
    return buildHealthResponse({
        indexer,
        indexerRunning: true,
        indexerError: null,
        lastIndexedBlock: 100,
        inFlightBlock: null,
        now: 1_700_000_000_000,
        reorgStats: null
    });
}

async function assertMatchesHealth(indexer, expected){
    const status = statusFor(indexer);
    const health = await healthFor(indexer);
    assert.deepStrictEqual(status.train_activation, expected);
    assert.deepStrictEqual(status.train_activation, health.train_activation);
}

describe('/status train_activation', function(){
    it('reports an unevaluated verdict before the first block is graded', async function(){
        await assertMatchesHealth(fakeIndexer(null), {
            status: 'unevaluated',
            active_rule_set: null,
            required_rule_set: null,
            required_at_height: null,
            classification: null,
            reason: 'no block has been evaluated against the train activation gate yet'
        });
    });

    it('copies a pending verdict', async function(){
        await assertMatchesHealth(fakeIndexer({
            status: 'pending',
            activeRuleSet: '1.0.0',
            requiredRuleSet: '2.0.0',
            requiredAtHeight: 970000,
            classification: 'major',
            reason: 'will halt at 970000'
        }), {
            status: 'pending',
            active_rule_set: '1.0.0',
            required_rule_set: '2.0.0',
            required_at_height: 970000,
            classification: 'major',
            reason: 'will halt at 970000'
        });
    });

    it('copies a halt verdict', async function(){
        await assertMatchesHealth(fakeIndexer({
            status: 'halt',
            activeRuleSet: '1.0.0',
            requiredRuleSet: '2.0.0',
            requiredAtHeight: 970000,
            classification: 'consensus-hotfix',
            reason: 'activation height reached'
        }), {
            status: 'halt',
            active_rule_set: '1.0.0',
            required_rule_set: '2.0.0',
            required_at_height: 970000,
            classification: 'consensus-hotfix',
            reason: 'activation height reached'
        });
    });

    it('reports unevaluated when there is no trainActivation property', async function(){
        const indexer = fakeIndexer(null);
        delete indexer.trainActivation;
        await assertMatchesHealth(indexer, {
            status: 'unevaluated',
            active_rule_set: null,
            required_rule_set: null,
            required_at_height: null,
            classification: null,
            reason: 'no block has been evaluated against the train activation gate yet'
        });
    });
});

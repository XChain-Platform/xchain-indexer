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
 * Health publishes the train activation verdict, including BEFORE it fires.
 *
 * Section 13.4 makes the announcement part of the mechanism, not a nicety: "a halt
 * that surprises the operator is a publication failure, not a gate failure". So the
 * assertion that matters here is the PENDING one, on a node that is still perfectly
 * healthy and still advancing: it must already carry the height and the rule-set
 * version needed, because that is the only window in which updating is cheap.
 *
 * The unevaluated case is asserted separately on purpose. A fresh process has no
 * verdict yet, and reporting that as `clear` would tell a fleet sweep that a node
 * which has never looked is compliant.
 *********************************************************************/

'use strict';

const assert = require('assert');
const { buildHealthResponse } = require('../../src/health');

// The minimum an indexer stand-in needs for buildHealthResponse: it reads a lot of
// optional fields and every one of them tolerates absence.
function fakeIndexer(trainActivation){
    return {
        decoderDb: null, indexerDb: null,
        isSynced: () => true,
        lastDecoderBlock: 100,
        trainActivation: trainActivation
    };
}

function health(trainActivation){
    return buildHealthResponse({
        indexer: fakeIndexer(trainActivation), indexerRunning: true, indexerError: null,
        lastIndexedBlock: 100, inFlightBlock: null, now: 1_700_000_000_000, reorgStats: null
    });
}

describe('health: train activation surfacing @regression', function () {

    it('reports a clear verdict with the active rule set', async function () {
        const r = await health({ status: 'clear', activeRuleSet: '1.0.0', requiredRuleSet: null,
                                 requiredAtHeight: null, classification: null, reason: null });
        assert.deepStrictEqual(r.train_activation, {
            status: 'clear', active_rule_set: '1.0.0', required_rule_set: null,
            required_at_height: null, classification: null, reason: null
        });
        assert.strictEqual(r.status, 'healthy', 'a clear verdict changes nothing about serving');
    });

    it('publishes the PENDING halt with the height and the version needed, while still healthy', async function () {
        const r = await health({ status: 'pending', activeRuleSet: '1.0.0', requiredRuleSet: '2.0.0',
                                 requiredAtHeight: 970000, classification: 'major',
                                 reason: 'will halt at 970000' });
        assert.strictEqual(r.train_activation.status, 'pending');
        assert.strictEqual(r.train_activation.required_rule_set, '2.0.0');
        assert.strictEqual(r.train_activation.required_at_height, 970000);
        assert.strictEqual(r.train_activation.classification, 'major');
        // The node is still advancing and still serving; this is the whole point of the
        // rolling-upgrade window. The pending verdict is the only warning there is.
        assert.strictEqual(r.status, 'healthy');
    });

    it('publishes a halt verdict with its reason', async function () {
        const r = await health({ status: 'halt', activeRuleSet: '1.0.0', requiredRuleSet: '2.0.0',
                                 requiredAtHeight: 970000, classification: 'consensus-hotfix',
                                 reason: 'block 970000 is at or above the 2.0.0 activation height' });
        assert.strictEqual(r.train_activation.status, 'halt');
        assert.match(r.train_activation.reason, /970000/);
    });

    it('reports UNEVALUATED rather than clear before the first block is graded', async function () {
        for (const empty of [null, undefined]) {
            const r = await health(empty);
            assert.strictEqual(r.train_activation.status, 'unevaluated',
                'a node that has never looked must not report itself compliant');
            assert.strictEqual(r.train_activation.required_rule_set, null);
        }
    });

    it('keeps a required height of 0 as 0 rather than collapsing it to null', async function () {
        // A regtest row is armed at 0, and `|| null` on a numeric field would erase it,
        // turning "armed from genesis" into "no height recorded".
        const r = await health({ status: 'halt', activeRuleSet: null, requiredRuleSet: '2.0.0',
                                 requiredAtHeight: 0, classification: 'major', reason: 'x' });
        assert.strictEqual(r.train_activation.required_at_height, 0);
    });
});

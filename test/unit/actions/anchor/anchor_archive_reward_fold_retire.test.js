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
 ********************************************************************/


'use strict';

const assert = require('assert');
const sinon = require('sinon');

const settle = require('../../../../src/actions/anchor/settle.js');
const ar = require('../../../../src/consensus/gates/anchor_reward_gate.js');
const observability = require('../../../../src/observability/index.js');
const { stubActiveAt } = require('../../../helpers/gate_modules.js');

const FOLD_GATE_KEY = 'anchor_fold_activation.ANCHOR_FOLD_ACTIVATION';
const PUBLISHER = '02'.repeat(33);
const SKIP_WARNING = '\t ANCHOR v1 : DOGE-side reward is derived on BTC; reward skipped';

function makeContext() {
    const indexerDb = {
        createValidatorReward: sinon.stub().resolves(true),
        reconcileAnchorRewardWinner: sinon.stub().resolves(1),
    };
    return {
        handler: { config: { COIN: 'DOGE', NETWORK: 'regtest' }, indexerDb },
        indexerDb,
        data: {
            NETWORK: 'regtest', BLOCK_INDEX: '8400', ACTION_INDEX: '9',
            SNAPSHOT_BLOCK: '8100', MATCH_BATCH_SEQ: '3', PUBLISHER,
        },
        snapPubkeys: new Set([PUBLISHER]),
    };
}

describe('ANCHOR archive reward settlement writes nothing', function () {
    afterEach(function () {
        sinon.restore();
    });

    for(const deriveActive of [false, true]){
        for(const foldActive of [false, true]){
            it('warns and writes no reward with derive ' + deriveActive + ' and fold ' + foldActive, async function () {
                sinon.stub(ar, 'isAnchorRewardDeriveActive').returns(deriveActive);
                const foldGate = stubActiveAt(sinon, FOLD_GATE_KEY, foldActive);
                const warn = sinon.stub(observability.getLogger(), 'warn');
                const { handler, indexerDb, data, snapPubkeys } = makeContext();

                await settle.creditArchiveReward(handler, data, true, snapPubkeys, 1);

                assert.strictEqual(foldGate.called, false);
                assert.strictEqual(indexerDb.createValidatorReward.called, false);
                assert.strictEqual(indexerDb.reconcileAnchorRewardWinner.called, false);
                assert.ok(warn.calledOnceWithExactly(SKIP_WARNING));
            });
        }
    }
});

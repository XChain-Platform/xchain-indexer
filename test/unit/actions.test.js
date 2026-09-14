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
 * test/unit/actions.test.js
 *
 * Unit tests for the Actions class (src/actions/index.js).
 *
 * All DB methods and action handler parse() methods are stubbed so that
 * no real database calls or action logic executes.
 *
 * This file holds the processTransaction() routing cases. The parsing cases
 * (legacy format, unknown and inactive actions, the data object, the DB calls)
 * and the processAction() dispatch cases live beside it under
 * test/unit/actions.test/, and the stubbed-Actions builder they all share is
 * test/unit/actions.test/helpers/build_actions.js. Every part repeats its suite
 * title, so each full test title is unchanged.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert  = require('assert');
const sinon   = require('sinon');

// The stubbed-Actions builder and the transaction fixture every part of the suite shares.
const { makeTx, shutdownPendingVms, buildActions } = require('./actions.test/helpers/build_actions.js');

// ---------------------------------------------------------------------------
// describe: processTransaction - action routing
// ---------------------------------------------------------------------------
describe('Actions.processTransaction() @regression @tier3', function () {
    afterEach(async function () {
        sinon.restore();
        await shutdownPendingVms();
    });

    // ── Basic routing ─────────────────────────────────────────────────────

    it('routes SEND to actionSend.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'SEND|0|TEST|100|addr' }));
        assert.ok(stubs.actionSend.calledOnce, 'actionSend.parse should be called once');
    });

    it('routes ISSUE to actionIssue.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'ISSUE|0|TEST|1000|100|8' }));
        assert.ok(stubs.actionIssue.calledOnce);
    });

    it('routes MINT to actionMint.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'MINT|0|TEST|100' }));
        assert.ok(stubs.actionMint.calledOnce);
    });

    it('routes AIRDROP to actionAirdrop.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'AIRDROP|0|TEST|10' }));
        assert.ok(stubs.actionAirdrop.calledOnce);
    });

    it('routes BROADCAST to actionBroadcast.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'BROADCAST|0|hello world' }));
        assert.ok(stubs.actionBroadcast.calledOnce);
    });

    it('routes DESTROY to actionDestroy.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'DESTROY|0|TEST|50' }));
        assert.ok(stubs.actionDestroy.calledOnce);
    });

    it('routes ADDRESS to actionAddress.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'ADDRESS|0|option|value' }));
        assert.ok(stubs.actionAddress.calledOnce);
    });

    it('routes BATCH to actionBatch.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'BATCH|0|cmd1;cmd2' }));
        assert.ok(stubs.actionBatch.calledOnce);
    });
});

describe('Actions.processTransaction() @regression @tier3', function () {
    afterEach(async function () {
        sinon.restore();
        await shutdownPendingVms();
    });

    it('routes CALLBACK to actionCallback.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'CALLBACK|0|1|TEST|50' }));
        assert.ok(stubs.actionCallback.calledOnce);
    });

    it('routes DISPENSER to actionDispenser.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'DISPENSER|0|TEST|100|1|100' }));
        assert.ok(stubs.actionDispenser.calledOnce);
    });

    it('routes DIVIDEND to actionDividend.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'DIVIDEND|0|TEST|GAS|100' }));
        assert.ok(stubs.actionDividend.calledOnce);
    });

    it('routes FILE to actionFile.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'FILE|0|myfile.txt' }));
        assert.ok(stubs.actionFile.calledOnce);
    });

    it('routes LINK to actionLink.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'LINK|0|1|2' }));
        assert.ok(stubs.actionLink.calledOnce);
    });

    it('routes LIST to actionList.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'LIST|0|ALLOW|addr1' }));
        assert.ok(stubs.actionList.calledOnce);
    });

    it('routes MESSAGE to actionMessage.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'MESSAGE|0|1|key|ciphertext' }));
        assert.ok(stubs.actionMessage.calledOnce);
    });

    it('routes ORDER to actionOrder.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'ORDER|0|TEST|100|GAS|50' }));
        assert.ok(stubs.actionOrder.calledOnce);
    });

    it('routes SLEEP to actionSleep.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'SLEEP|0|200' }));
        assert.ok(stubs.actionSleep.calledOnce);
    });
});

describe('Actions.processTransaction() @regression @tier3', function () {
    afterEach(async function () {
        sinon.restore();
        await shutdownPendingVms();
    });

    it('routes SWAP to actionSwap.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'SWAP|0|TEST|100|GAS|50' }));
        assert.ok(stubs.actionSwap.calledOnce);
    });

    it('routes SWEEP to actionSweep.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'SWEEP|0|destaddr' }));
        assert.ok(stubs.actionSweep.calledOnce);
    });

    // ── Recently-added handlers (staking COLLECT, oracle PRICE, attestation) ─

    it('routes COLLECT to actionCollect.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'COLLECT|0' }));
        assert.ok(stubs.actionCollect.calledOnce, 'COLLECT should route to actionCollect.parse');
    });

    it('routes PRICE to actionPrice.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'PRICE|1|BTC|TEST|USD|1.00|0|memo' }));
        assert.ok(stubs.actionPrice.calledOnce, 'PRICE should route to actionPrice.parse');
    });

    it('routes ATTEST to actionAttest.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'ATTEST|1|' + 'a'.repeat(64) + '|http_get|payload|ok|meta|0' }));
        assert.ok(stubs.actionAttest.calledOnce, 'ATTEST should route to actionAttest.parse');
    });

    // ── Aliases ───────────────────────────────────────────────────────────

    it('routes DEPLOY to actionDeploy.parse', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'DEPLOY|0|abcdef|1000' }));
        assert.ok(stubs.actionDeploy.calledOnce, 'DEPLOY should route to actionDeploy.parse');
        assert.ok(stubs.actionIssue.notCalled);
    });

    it('resolves TRANSFER alias to SEND', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'TRANSFER|0|TEST|100|addr' }));
        assert.ok(stubs.actionSend.calledOnce, 'TRANSFER should route to actionSend.parse');
    });

    it('resolves ADDR alias to ADDRESS', async function () {
        const { actions, stubs } = buildActions();
        await actions.processTransaction(makeTx({ data: 'ADDR|0|opt|val' }));
        assert.ok(stubs.actionAddress.calledOnce, 'ADDR should route to actionAddress.parse');
    });
});

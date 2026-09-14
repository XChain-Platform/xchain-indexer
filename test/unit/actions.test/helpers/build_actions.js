/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The stubbed Actions builder shared by test/unit/actions.test.js and its parts
 * under test/unit/actions.test/: the transaction fixture, the protocolChanges mock,
 * and the VM shutdown every describe calls from its afterEach.
 *
 * Every caller sets INDEXER_COIN and INDEXER_NETWORK before requiring this module,
 * so Actions loads under the same environment the suite has always given it.
 *
 ********************************************************************/

'use strict';

const sinon   = require('sinon');

const { createMockIndexer } = require('../../../fixtures/mocks');
const Actions               = require('../../../../src/actions/index');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a mock protocolChanges object.
 * By default, every action is defined and enabled.
 */
function makeProtocolChanges({ defined = true, enabled = true } = {}) {
    return {
        isDefined:  sinon.stub().returns(defined),
        isEnabled:  sinon.stub().resolves(enabled),
    };
}

/**
 * Build a minimal transaction object as xchain-decoder would produce.
 */
function makeTx(overrides = {}) {
    return {
        source:      'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        destination: 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        amount:      '0.00000000',
        tx_hash:     'a'.repeat(64),
        vout:        0,
        block_index: 100,
        block_time:  1700000000,
        data:        'SEND|0|TEST|100|mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM',
        ...overrides,
    };
}

// Every buildActions() call below constructs a real Actions instance, which
// forks a persistent VM subprocess worker (src/actions/index.js, execution:
// 'subprocess'). Nothing here ever called vm.shutdown(), so those forks
// outlived every test and the mocha process never exited on its own. Track
// each VM buildActions() creates so the describes' afterEach hooks can shut
// them all down.
const pendingVms = [];

async function shutdownPendingVms() {
    while (pendingVms.length) {
        await pendingVms.pop().shutdown();
    }
}

/**
 * Instantiate Actions and stub all handler parse() methods.
 * Returns { actions, indexer, stubs } so tests can inspect calls.
 */
function buildActions(protocolChangesOverrides = {}) {
    const indexer = createMockIndexer();
    indexer.protocolChanges = makeProtocolChanges(protocolChangesOverrides);

    const actions = new Actions(indexer);
    pendingVms.push(actions.vm);

    // Stub every handler's parse() with a resolved stub.
    //
    // The list is derived from the live Actions instance : any `action*`
    // property exposing a parse() method : rather than hardcoded. A hardcoded
    // list drifts: handlers get added to Actions (e.g. COLLECT, PRICE, ATTEST)
    // without a matching stub, so routing for them runs the real handler against
    // a mock DB; conversely a renamed/removed handler leaves a stale key that
    // makes sinon.stub() throw on undefined and breaks the whole file. Deriving
    // keeps the stub set in lockstep with what Actions actually registers.
    // (actionAliases is excluded automatically : it has no parse() method.)
    const handlerKeys = Object.keys(actions).filter(
        (key) => key.startsWith('action')
            && actions[key]
            && typeof actions[key].parse === 'function'
    );

    const stubs = {};
    for (const key of handlerKeys) {
        stubs[key] = sinon.stub(actions[key], 'parse').resolves();
    }

    return { actions, indexer, stubs };
}

module.exports = { makeTx, shutdownPendingVms, buildActions };

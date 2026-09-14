'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The shared helpers of the ISSUE suites, issue.test.js and the parts in
// issue.test/: each suite rebuilds its handler through buildIssue() before every
// test, so every same-title sibling block starts from the same state.

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../../../fixtures/mocks');

const Issue = require('../../../../../src/actions/issue.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an actionsCtx object the Issue handler expects.
 */
function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            // ISSUANCE_FEE is block-gated (protocol_changes.js: mainnet 862633);
            // mirror that so sub-activation blocks skip the fee (all other changes on).
            isEnabled:  sinon.stub().callsFake(async (name, block) =>
                name === "ISSUANCE_FEE" ? Number(block) >= 862633 : true),
        },
        processAction: sinon.stub().resolves(),
    };
}

/**
 * Build the params array for format 0 (full).
 * Fields: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|
 *         TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|
 *         LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|
 *         ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|
 *         LOCK_MINT|LOCK_MINT_SUPPLY|MEMO
 */
function makeFormat0Params(overrides = {}) {
    const defaults = {
        VERSION:         '0',
        TICK:            'TEST',
        MAX_SUPPLY:      '1000',
        MAX_MINT:        '100',
        DECIMALS:        '0',
        DESCRIPTION:     'Test token',
        MINT_SUPPLY:     '',
        TRANSFER:        '',
        TRANSFER_SUPPLY: '',
        LOCK_MAX_SUPPLY: '',
        LOCK_MAX_MINT:   '',
        LOCK_DESCRIPTION:'',
        LOCK_SLEEP:      '',
        LOCK_CALLBACK:   '',
        CALLBACK_BLOCK:  '',
        CALLBACK_TICK:   '',
        CALLBACK_AMOUNT: '',
        ALLOW_LIST:      '',
        BLOCK_LIST:      '',
        MINT_ADDRESS_MAX:'',
        MINT_START_BLOCK:'',
        MINT_STOP_BLOCK: '',
        LOCK_MINT:       '',
        LOCK_MINT_SUPPLY:'',
        MEMO:            '',
    };
    const merged = Object.assign({}, defaults, overrides);
    return [
        merged.VERSION, merged.TICK, merged.MAX_SUPPLY, merged.MAX_MINT, merged.DECIMALS,
        merged.DESCRIPTION, merged.MINT_SUPPLY, merged.TRANSFER, merged.TRANSFER_SUPPLY,
        merged.LOCK_MAX_SUPPLY, merged.LOCK_MAX_MINT, merged.LOCK_DESCRIPTION,
        merged.LOCK_SLEEP, merged.LOCK_CALLBACK, merged.CALLBACK_BLOCK, merged.CALLBACK_TICK,
        merged.CALLBACK_AMOUNT, merged.ALLOW_LIST, merged.BLOCK_LIST, merged.MINT_ADDRESS_MAX,
        merged.MINT_START_BLOCK, merged.MINT_STOP_BLOCK, merged.LOCK_MINT, merged.LOCK_MINT_SUPPLY,
        merged.MEMO,
    ];
}

/**
 * Create a data object for ISSUE with a given format version already resolved.
 */
function makeData(overrides = {}) {
    return createBaseData(Object.assign({ ACTION: 'ISSUE', FORMAT: 0 }, overrides));
}

// ---------------------------------------------------------------------------
// Shared setup: new-token tests need an XCHAIN balance to pay the issuance fee.
// BLOCK_INDEX < 862633 skips the fee requirement entirely.
// ---------------------------------------------------------------------------
const LOW_BLOCK = 100; // below 862633 → no fee required for new token

/** A fresh mock indexer and ISSUE handler, with the suite's defaults set below. */
function buildIssue() {
    const indexer    = createMockIndexer();
    const actionsCtx = makeActionsCtx(indexer);
    const handler    = new Issue(actionsCtx);

    // Default: no existing token, not distributed
    indexer.indexerDb.getTokenInfo.resolves(null);
    indexer.indexerDb.isDistributed.resolves(false);
    // isActionAllowed returns true (address not sleeping)
    indexer.indexerDb.isActionAllowed.resolves(true);
    // Zero fee scenario - no GAS balance needed when block < 862633
    indexer.indexerDb.getAddressBalances.resolves({});
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getTokenSupply.resolves('0');
    return { indexer, actionsCtx, handler };
}

module.exports = { makeFormat0Params, makeData, LOW_BLOCK, buildIssue };

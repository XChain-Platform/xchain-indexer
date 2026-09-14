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

const sinon = require('sinon');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake indexer with stubbed indexerDb methods and
 * an optional hubClient.
 */
function makeIndexer(hubClientOpts){
    let hubClient = Object.assign({
        enabled:        true,
        pushPriceRound: sinon.stub().resolves(),
        pushOraclePrice: sinon.stub().resolves(),
        pushPriceBatch: sinon.stub().resolves(),
        pushAttestBatch: sinon.stub().resolves(),
        retractPriceRange: sinon.stub().resolves(),
        retractXcallRange: sinon.stub().resolves(),
        retractMatchRange: sinon.stub().resolves(),
        retractAttestBatch: sinon.stub().resolves()
    }, hubClientOpts || {});

    let indexerDb = {
        getPendingHubPushes:    sinon.stub().resolves([]),
        recordHubPushAttempt:   sinon.stub().resolves(),
        markHubPushDelivered:   sinon.stub().resolves()
    };

    return { hubClient, indexerDb };
}

/**
 * Build a row the way the DB returns it.
 */
function makeRow(overrides){
    return Object.assign({
        id:                 1,
        push_type:          'price_round',
        payload:            JSON.stringify({ round: 5 }),
        attempts:           0,
        last_attempted_at:  null
    }, overrides || {});
}

module.exports = { makeIndexer, makeRow };

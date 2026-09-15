// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Shared fixtures for consolidation_leg_amount.test.js and its part in
// test/unit/actions/consolidation_leg_amount.test/.

'use strict';

const sinon = require('sinon');
const activation = require('../../../../../src/consolidation_leg_amount_activation.js');

// Any network the activation map does not carry reads as OFF, which is how these tests
// reach the legacy behavior without editing the module's thresholds.
const GATE_OFF_NETWORK = 'no-such-network';

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DEST   = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';
const DEST2  = 'n2j7X44Gm6P4E9cs2H13EkBAotYbjPZW17';

function makeActionsCtx(indexer) {
    return {
        config:          indexer.config,
        util:            indexer.util,
        mapper:          indexer.mapper,
        decoderDb:       indexer.decoderDb,
        indexerDb:       indexer.indexerDb,
        protocolChanges: {
            isDefined:  sinon.stub().returns(true),
            isEnabled:  sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

module.exports = { activation, GATE_OFF_NETWORK, SOURCE, DEST, DEST2, makeActionsCtx };

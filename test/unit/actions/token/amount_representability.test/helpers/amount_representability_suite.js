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
// Shared fixtures for amount_representability.test.js and its part in
// test/unit/actions/amount_representability.test/.

'use strict';

const sinon = require('sinon');
const activation = require('../../../../../../src/utility/amount_representability_gate.js');

// Any network the activation map does not carry reads as OFF, which is how these tests
// reach the legacy behavior without editing the module's thresholds.
const GATE_OFF_NETWORK = 'no-such-network';

// A block time inside the regtest-armed window and far below the unarmed sentinel.
const BLOCK_TIME = 1700000000;

const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DEST   = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';

// Run `fn` with the regtest threshold temporarily moved, restoring it byte-exact after.
// Used for the gate-off controls that must isolate THIS gate rather than turning every
// network-keyed gate in the action path off at once.
function withRegtestThreshold(value, fn) {
    const map   = activation.AMOUNT_REPRESENTABILITY_ACTIVATION;
    const saved = map.regtest;
    map.regtest = value;
    try { return fn(); } finally { map.regtest = saved; }
}

// The async form. The synchronous one restores the threshold the instant `fn` RETURNS,
// which for an async `fn` is before it has reached the validator at all, so the control
// would silently run with the gate back on. Measured: the SEND control below failed
// exactly that way on its first run.
async function withRegtestThresholdAsync(value, fn) {
    const map   = activation.AMOUNT_REPRESENTABILITY_ACTIVATION;
    const saved = map.regtest;
    map.regtest = value;
    try { return await fn(); } finally { map.regtest = saved; }
}

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

module.exports = {
    activation, GATE_OFF_NETWORK, BLOCK_TIME, SOURCE, DEST,
    withRegtestThreshold, withRegtestThresholdAsync, makeActionsCtx,
};

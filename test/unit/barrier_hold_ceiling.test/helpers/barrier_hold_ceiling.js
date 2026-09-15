// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// test/unit/barrier_hold_ceiling.test/helpers/barrier_hold_ceiling.js
//
// Shared source bindings and fixed clock used by the split barrier hold tests.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const HubDbSync = require('../../../../src/hub/hub_db_sync.js');
const {
    HUB_SYNC_BARRIER_HOLD_CEILING_S,
    resolveBarrierHoldCeilingMs
} = require('../../../../src/hub/hub_db_sync.js');
const XChainIndexer = require('../../../../src/XChainIndexer.js');
const { nextBarrierHold, barrierHoldMs, barrierCeilingExceeded,
        isMirrorBarrierReason } = require('../../../../src/XChainIndexer.js');

const NOW = 1800000000000;

module.exports = {
    assert, fs, path, sinon, HubDbSync, HUB_SYNC_BARRIER_HOLD_CEILING_S,
    resolveBarrierHoldCeilingMs, XChainIndexer, nextBarrierHold,
    barrierHoldMs, barrierCeilingExceeded, isMirrorBarrierReason, NOW
};

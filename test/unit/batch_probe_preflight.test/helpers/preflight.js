// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// test/unit/batch_probe_preflight.test/helpers/preflight.js
//
// Shared action bindings and mock factories for the split batch pre-flight tests.

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const sinon   = require('sinon');
const Actions = require('../../../../src/actions/index.js');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');

module.exports = { assert, sinon, Actions, createMockIndexer, createBaseData, createTokenInfo };

/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/consensus_rules_digest.test/helpers/consensus_rules_digest.js
 *
 * Shared bindings for the split consensus rules digest tests.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const crd    = require('../../../../src/consensus_rules_digest.js');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');

module.exports = { assert, fs, path, crd, siblingCheckout, skipOrFail };

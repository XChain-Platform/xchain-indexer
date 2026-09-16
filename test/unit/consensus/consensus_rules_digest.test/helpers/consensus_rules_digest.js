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
 * test/unit/consensus/consensus_rules_digest.test/helpers/consensus_rules_digest.js
 *
 * Shared bindings for the split consensus rules digest tests.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const crd    = require('../../../../../src/consensus_rules_digest.js');
const { siblingCheckout, skipOrFail } = require('../../../../helpers/sibling_checkout.js');

// The digest reads every gate VALUE from the registry (through the
// src/consensus/gate_registry alias), so a case that needs one map to read
// differently swaps the alias's cached module for one whose get() answers that
// key with `table`; the carriers themselves are never touched. Returns the
// restorer. The caller still drops the digest's own cache entry and re-requires
// it, since the digest memoizes the values it read at load.
function stubRegistryRow(key, table) {
    const REG  = require.resolve('../../../../../src/consensus/gate_registry.js');
    const real = require.cache[REG];
    const stub = Object.create(Object.getPrototypeOf(real));
    Object.assign(stub, real);
    stub.exports = Object.assign({}, real.exports, {
        get: (k) => (k === key ? Object.freeze(Object.assign({}, table)) : real.exports.get(k)),
    });
    require.cache[REG] = stub;
    return () => { require.cache[REG] = real; };
}

module.exports = { assert, fs, path, crd, siblingCheckout, skipOrFail, stubRegistryRow };

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Test helper: hold the oracle snapshot age on its block-count basis.
 *
 * Regtest reads the age in consensus seconds from genesis, while every
 * production network keeps the block-count read until its activation height
 * is named. A suite that grades the block-count read on a regtest config
 * calls this so it keeps testing the path the production networks still run.
 */

'use strict';

const gateRegistry = require('../../src/consensus/gate_registry');
const { SECONDS_ACTIVATION } = require('../../src/db/prices/oracle_snapshot_age_seconds');

// Answer "not active" for the seconds-basis row only; every other gate keeps its
// live verdict. The caller's sinon sandbox restores the registry afterwards.
function holdSecondsBasisInert(sinon) {
    const activeAt = gateRegistry.activeAt.bind(gateRegistry);
    return sinon.stub(gateRegistry, 'activeAt').callsFake((key, ...args) =>
        key === SECONDS_ACTIVATION ? false : activeAt(key, ...args));
}

module.exports = { holdSecondsBasisInert };

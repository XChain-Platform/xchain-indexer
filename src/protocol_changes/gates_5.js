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
 *
 * Indexer-only registry rows, part 5: mainnet launch
 *
 * The launch instant and the prelaunch seed source map read by
 * src/consensus/gates/prelaunch_seed_sources.js. Opened after gates_4.js
 * reached the file-size limit.
 *
 ********************************************************************/

'use strict';

const { addGate, UNARMED } = require('./shared_rows.js');

// mainnet_launch_activation
// MAINNET_LAUNCH_ACTIVATION: the block time from which mainnet admits every transaction.
// Before it only validator wire actions and pinned seed sources are admitted. Testnet and
// regtest are open networks and never consult it, so testnet stays UNARMED.
addGate('mainnet_launch_activation.MAINNET_LAUNCH_ACTIVATION', 'time', {
    mainnet: 1798761600,
    testnet: UNARMED,
    regtest: 0,
});

// prelaunch_seed_sources
// PRELAUNCH_SEED_SOURCES: '<COIN>:mainnet' -> the source addresses admitted before launch.
// Empty until a release pins the seed sources, so before launch nothing but a validator
// wire action is admitted.
addGate('prelaunch_seed_sources.PRELAUNCH_SEED_SOURCES', 'constant', {});

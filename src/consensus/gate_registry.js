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
 * Alias so every repo reaches the activation registry at the same path
 * (D72). In this repo the registry itself is src/protocol_changes.js (O4);
 * every consumer repo's src/consensus/gate_registry.js is its own registry.
 *
 ********************************************************************/

'use strict';

module.exports = require('../protocol_changes');

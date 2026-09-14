/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
 * XChain Platform Action - BATCH (require path)
 *
 * The BATCH handler lives in src/actions/batch/, entry index.js with one part per
 * behaviour beside it. This file keeps the path src/actions/batch.js resolving for
 * the action loader (actions_class/handler_wiring.js) and every suite or tool that
 * requires it with its extension, so none of them had to move with the split.
 *
 * It is temporary by design: the xchain-sdk pre-flight drift gate pins a handler
 * directory only while no flat <name>.js sits beside it (require() would resolve the
 * flat file first), so this file goes once those requirers name the directory.
 *
 ********************************************************************/

module.exports = require('./batch/index.js');

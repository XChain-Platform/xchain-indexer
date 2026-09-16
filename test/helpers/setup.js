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
 * Mocha bootstrap, loaded via --require before any test file.
 *
 * The suites stub, spy on and outright reassign the global console in dozens of
 * files, and any test file that pulls in src/api.js would otherwise install the
 * console patch for the whole run: from that point every assertion about a log
 * line would be reading a formatted, level-gated line instead of what the code
 * under test actually passed. The patch is a production wiring concern and is
 * covered directly in the observability shim's own unit tests, which opt back in.
 *
 ********************************************************************/

'use strict';

process.env.XCHAIN_LOG_PATCH = '0';

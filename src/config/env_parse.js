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
 * Environment value parsing for src/config.js.
 *
 * Pure coercion only: the caller reads process.env (src/config.js is the one
 * module allowed to) and hands the raw value in, so the default stays visible
 * at the read site where the env-var doc coverage scanner looks for it.
 ********************************************************************/

'use strict';

// Parse a non-negative integer from an env var, falling back to defaultVal when
// the value is absent, empty, or non-numeric. Unlike `parseInt(x) || default`,
// this preserves 0 as a valid configured value.
const parseIntMin0 = (val, defaultVal) => {
    if(val === undefined || val === null || val === '') return defaultVal;
    let parsed = parseInt(val, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultVal;
};

module.exports = { parseIntMin0 };

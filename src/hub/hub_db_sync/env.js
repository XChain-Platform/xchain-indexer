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
 * XChain Indexer - Hub DB Sync Client: environment reads
 *
 * The ONE place the hub-mirror client reads the process environment.
 *
 * WHY THIS IS NOT src/config.js. CODE-STYLE "Module shape" routes every env read
 * through the service's config home, and the indexer has one (readEnvNow and the
 * frozen CONFIG_ENV map in src/config.js). This client cannot require it: the file
 * is vendored byte-identical into xchain-explorer, where `../../config.js` resolves
 * to the EXPLORER's config module, which exports neither name, so the require
 * would load and then fail at the first call. A module of its own, vendored with
 * the rest of the client, is the only shape that resolves on both sides.
 *
 * WHY READ-AT-CALL AND NOT A LOAD-TIME SNAPSHOT. Every key this client reads is
 * resolved when a mirror is CONSTRUCTED or when a grace resolver runs, and the
 * regtest-only overrides are set between one construction and the next (the grace
 * resolver suite sets a value, builds a mirror, asserts, clears it). A copy frozen
 * at require time would hand every later mirror the first process's view. This is
 * the same contract src/config.js readEnvNow keeps for its own computed reads.
 *
 * Part of the hub-mirror client (src/hub/hub_db_sync.js). Vendored byte-identical
 * into xchain-explorer by bin/sync-hub-mirror-client.sh: edit the xchain-indexer copy.
 *
 ********************************************************************/

// Return process.env[key] as it is NOW. Raw value only: every default and every
// coercion stays at the read site, so this cannot move the point at which a
// default is decided.
function readEnvNow(key) {
    return process.env[key];
}

module.exports = { readEnvNow };

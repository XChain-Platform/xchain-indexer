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
 * XChain Indexer - Hub mirror schema version
 *
 * Schema version of the hub-db mirror contract (WS broadcasts + REST
 * snapshots). The hub stamps every payload with this number; the indexer
 * refuses to apply rows from a hub running a different version, so a hub that
 * adds a consensus-relevant column before this indexer migrates cannot
 * silently fork the ledger. MUST stay in lockstep with
 * xchain-hub/src/hub-schema-version.js; bump both together whenever the mirror
 * row shape changes.
 *
 ********************************************************************/

// v2 : capability_snapshots.uq_cap_snap gained `source`, so the hub now
// mirrors both (source, pubkey) rows for a multi-source key. Lockstep with
// xchain-hub/src/hub-schema-version.js (already at v2); a v1 indexer must reject
// the v2 stream until its own uq_cap_snap is widened (2026-07-20 migration).
const HUB_SCHEMA_VERSION = 2;

module.exports = { HUB_SCHEMA_VERSION };

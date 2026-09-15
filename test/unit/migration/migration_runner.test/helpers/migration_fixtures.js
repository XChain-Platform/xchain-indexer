'use strict';

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
 * Schema migration runner: pure-logic contract tests (no live DB).
 *
 * Covers the gate that decides whether a migration runs unattended at startup:
 * migrationMode() header parsing, and the invariant that every committed migration
 * declares its intent explicitly so a destructive file can never default-silently
 * into the auto-apply path on a validator fleet.
 *
 ********************************************************************/

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../../../../src/db');
const { requireWithFreshConfig } = require('../../../../helpers/fresh_config.js');
const DB_PATH = require.resolve('../../../../../src/db');

// migrationMode is a pure string function : bind it to a bare object.
const modeOf = Database.prototype.migrationMode.bind({});

// Destructive-DDL guard helpers: same comment-strip + quote-aware split runMigrations uses.
// Bind to the prototype so destructiveAutoStatement can reach isIdRepairUpdate and
// splitSqlStatements can reach stripSqlLineComments (both pure, no instance state).
const stripComments = Database.prototype.stripSqlLineComments.bind({});
const destructiveOf = Database.prototype.destructiveAutoStatement.bind(Database.prototype);
const statementsOf  = (raw) => Database.prototype.splitSqlStatements.call(Database.prototype, raw);

// runMigrations() makes four fail-closed schema assertions on every normal return, and each
// one asks the live schema a question the fake connections below have to answer. The pubkey
// width, the stake-weight collation and the reward-key assertions all read
// information_schema.columns/statistics and pass through on an empty answer, because an
// absent column is a fresh install rather than drift - which is why a bare fake conn that
// returns [] has always satisfied them. assertBridgeTablesPresent reads
// information_schema.TABLES, where an empty answer is NOT ambiguous: zero rows means the
// three tables really are gone, and halting is the whole point of the guard.
//
// So the harnesses below seed the probe the same way makeDb() seeds the migrated pubkey
// width: they are testing the migration RUNNER against a deliberately bare ledger, not the
// schema contract, and a runner test must not be the thing that decides whether a node may
// boot without the bridge tables. The production assertion is left exactly as written; the
// halt it exists for is pinned by the Database.runMigrations() bridge-table schema assertion describe block in schema_assertions.test.js.
const BRIDGE_TABLES_PROBE = /information_schema\.tables[\s\S]*bridge_transfers/i;
const BRIDGE_TABLE_ROWS   = Object.freeze(['bridge_transfers', 'bridge_settlements', 'policy_snapshots']);
const bridgeTablesPresent = () => BRIDGE_TABLE_ROWS.map((name) => ({ name }));

module.exports = { assert, fs, path, Database, requireWithFreshConfig, DB_PATH, modeOf, stripComments, destructiveOf, statementsOf, BRIDGE_TABLES_PROBE, BRIDGE_TABLE_ROWS, bridgeTablesPresent };

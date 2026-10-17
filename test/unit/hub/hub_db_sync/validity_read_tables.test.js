'use strict';

/*********************************************************************
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *********************************************************************/

const assert = require('assert');
const tables = require('../../../../src/hub/hub_db_sync/mirror_tables.js');

describe('hub mirror validity-read table classifications @regression @tier1', function () {
    it('classifies every validity read outside the global state watermark', function () {
        const required = [
            'remote_token_snapshots', 'list_snapshots', 'policy_snapshots',
            'bridge_transfers', 'cross_chain_matches', 'cross_chain_calls',
        ];
        assert.deepStrictEqual(tables.VALIDITY_READ_TABLES, required);
        for (const table of tables.VALIDITY_READ_TABLES) {
            assert.ok(tables.MIRRORED_TABLES.includes(table), table + ' must be mirrored');
            assert.ok(!tables.HUB_STATE_TABLES.includes(table),
                table + ' must not claim the global seconds watermark as validity evidence');
        }
    });

    it('puts every retractable validity read in the quorum class', function () {
        for (const table of tables.VALIDITY_READ_TABLES) {
            if (!(table in tables.RETRACTION_COLUMNS)) continue;
            assert.ok(tables.QUORUM_CLASS_TABLES.includes(table),
                table + ' has a retraction column but lacks quorum-class deletion guards');
        }
        assert.deepStrictEqual(tables.QUORUM_CLASS_TABLES,
            ['cross_chain_matches', 'cross_chain_calls', 'bridge_transfers']);
    });

    it('classifies remote token snapshots only under its height watermark', function () {
        assert.deepStrictEqual(tables.HEIGHT_MIRROR_TABLES, ['remote_token_snapshots']);
        assert.ok(!tables.HUB_STATE_TABLES.includes('remote_token_snapshots'));
    });
});

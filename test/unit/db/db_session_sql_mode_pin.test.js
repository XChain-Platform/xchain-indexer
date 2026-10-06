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
 ********************************************************************/

const assert = require('assert');

const { SESSION_INIT_SQL } = require('../../../src/db/shared.js');
const {
    connectionParams,
    connectionPoolParams,
} = require('../../../src/db/database/instance_state.js');

describe('database session sql_mode pin @regression @tier1', function () {
    const state = {
        host:   'db.example',
        port:   3306,
        dbName: 'indexer',
        user:   'indexer-user',
        pass:   'indexer-pass',
    };

    it('pins sql_mode on direct and pooled connections', function () {
        assert.strictEqual(connectionParams(state).initSql, SESSION_INIT_SQL);
        assert.strictEqual(connectionPoolParams(state).initSql, SESSION_INIT_SQL);
    });

    it('keeps the credentials and pool options alongside the pin', function () {
        const pool = connectionPoolParams(state);
        assert.strictEqual(pool.host, 'db.example');
        assert.strictEqual(pool.database, 'indexer');
        assert.strictEqual(pool.connectionLimit, 10);
    });
});

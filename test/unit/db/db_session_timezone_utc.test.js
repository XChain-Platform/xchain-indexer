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

const {
    connectionParams,
    connectionPoolParams,
} = require('../../../src/db/database/instance_state.js');

describe('database session time zone @regression @tier1', function () {
    const state = {
        host:   'db.example',
        port:   3306,
        dbName: 'indexer',
        user:   'indexer-user',
        pass:   'indexer-pass',
    };

    it('pins direct and pooled connections to UTC', function () {
        const direct = connectionParams(state);
        const pool = connectionPoolParams(state);

        assert.strictEqual(direct.timezone, 'Z');
        assert.strictEqual(pool.timezone, 'Z');
        assert.strictEqual(pool.bigIntAsNumber, true);
        assert.strictEqual(pool.connectionLimit, 10);
    });
});

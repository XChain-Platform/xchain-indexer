/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************/

'use strict';

const assert = require('assert');
const bridgeSettlements = require('../../../src/db/bridge_settlements');

describe('db.getRecordedPolicyRefusalIds @regression @tier1', function(){
    it('reads only refused rows with one bound placeholder per snapshot id', async function(){
        const expected = [{ transfer_id: 'snapshot-a' }];
        let query;
        const db = {
            async doQuery(sql, args){
                query = { sql, args };
                return expected;
            }
        };
        const ids = ['snapshot-a', 'snapshot-b'];

        const rows = await bridgeSettlements.getRecordedPolicyRefusalIds.call(db, ids);

        assert.match(query.sql, /kind\s*=\s*'refused'/);
        assert.match(query.sql, /transfer_id\s+IN\s*\(\?,\s*\?\)/i);
        assert.deepStrictEqual(query.args, ids);
        assert.strictEqual(rows, expected);
    });
});

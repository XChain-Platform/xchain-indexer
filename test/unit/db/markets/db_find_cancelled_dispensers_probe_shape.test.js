/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const dispensers = require('../../../../src/db/dispensers/index.js');

describe('cancelled dispenser latest-status probe shape @regression @tier1', function () {

    afterEach(() => sinon.restore());

    it('keys the correlated MAX probe by dispenser and orders the result by action', async function () {
        const db = {
            config: { NETWORK: 'regtest', COIN: 'BTC', DISPENSER_CLOSE_DELAY: 100 },
            doQuery: sinon.stub().resolves([]),
        };

        await dispensers.findCancelledDispensers.call(db, 700, 20);

        sinon.assert.calledOnce(db.doQuery);
        assert.deepStrictEqual(db.doQuery.firstCall.args[1], []);

        const query = db.doQuery.firstCall.args[0].replace(/\s+/g, ' ').trim();
        assert.match(query,
            /INNER JOIN dispenser_statuses s1 ON \(s1\.dispenser_action_index=m\.action_index\)/);
        assert.match(query,
            /s1\.action_index = \( SELECT MAX\(s3\.action_index\) FROM dispenser_statuses s3 WHERE s3\.dispenser_action_index=m\.action_index \) AND/);
        assert.match(query, /ORDER BY m\.action_index ASC$/);
    });
});

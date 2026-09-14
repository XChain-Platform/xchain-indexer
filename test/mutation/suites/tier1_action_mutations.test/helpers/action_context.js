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
 * Shared setup for the tier 1 action mutation suite (../../tier1_action_mutations.test.js
 * and the parts beside this directory): the addresses, the token and balance
 * builders, and one happy-path handler context per action.
 */

'use strict';

const {
    createMockIndexer, createTokenInfo, makeActionsCtx,
} = require('../../../setup/harness');

const Send = require('../../../../../src/actions/send.js');
const Destroy = require('../../../../../src/actions/destroy.js');
const Issue = require('../../../../../src/actions/issue.js');

// Valid BTC addresses
const SOURCE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const DESTINATION = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';

function makeToken(overrides = {}) {
    return createTokenInfo(Object.assign({ TICK: 'TEST', TICK_ID: 1, DECIMALS: 0 }, overrides));
}

function makeBalances(tickId, amount) {
    return { [tickId]: amount };
}

/** A Send handler over a fresh mock indexer, stubbed so a plain send is valid. */
function sendContext() {
    const indexer = createMockIndexer();
    const handler = new Send(makeActionsCtx(indexer));

    // Happy-path defaults
    const token = makeToken();
    indexer.indexerDb.getTokenInfo.resolves(token);
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    indexer.indexerDb.getAddressBalances.resolves(makeBalances(1, 1000));
    indexer.indexerDb.findMatchingDispensers.resolves([]);
    indexer.indexerDb.findDispenserSends.resolves([]);
    return { indexer, handler };
}

/** A Destroy handler over a fresh mock indexer whose source holds 1000 TEST. */
function destroyContext() {
    const indexer = createMockIndexer();
    const handler = new Destroy(makeActionsCtx(indexer));

    const token = makeToken();
    indexer.indexerDb.getTokenInfo.resolves(token);
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getAddressBalances.resolves(makeBalances(1, 1000));
    return { indexer, handler };
}

/** An Issue handler over a fresh mock indexer, set up to create a new token. */
function issueContext() {
    const indexer = createMockIndexer();
    const handler = new Issue(makeActionsCtx(indexer));

    // New token creation scenario
    indexer.indexerDb.getTokenInfo.resolves(null);
    indexer.indexerDb.isDistributed.resolves(false);
    indexer.indexerDb.isActionAllowed.resolves(true);
    indexer.indexerDb.getAddressBalances.resolves({});
    indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
    return { indexer, handler };
}

module.exports = { SOURCE, DESTINATION, makeToken, makeBalances, sendContext, destroyContext, issueContext };

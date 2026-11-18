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
 **********************************************************************
 * test/unit/cross_chain/malformed_signature_columns.test.js
 *
 * The canonical quorum verifier reads a validator_signatures column that parses as JSON
 * of the wrong shape as zero valid signers. These cases pin that existing guard.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { verifyCanonicalQuorum } = require('../../../src/actions/cross_settle/quorum.js');

const PUBKEY = 'b'.repeat(64);

// A single-validator snapshot, served for both the weighted and the count read so the test
// does not depend on which side of the quorum gate the row's height falls.
function snapshotDb(){
    let validators = [{ pubkey: PUBKEY, source_id: 1, stake: '1' }];
    return {
        getValidatorsByCapability:  async () => validators,
        getStakeWeightsByCapability: async () => validators
    };
}

const MALFORMED = ['null', '{}', '5', '"x"', 'true', '[null]', '[5]', '["x"]', '[[]]', '{"pubkey":"a"}'];

describe('canonical quorum signature shape guard @regression @tier1', function () {

    for(let text of MALFORMED){
        it('canonical quorum reads the column ' + text + ' as no signers without throwing', async function () {
            let q = await verifyCanonicalQuorum(snapshotDb(), 'canonical', text, 1, 'regtest');
            assert.strictEqual(q.met, false);
            assert.strictEqual(q.snapshotAbsent, false);
        });
    }
});

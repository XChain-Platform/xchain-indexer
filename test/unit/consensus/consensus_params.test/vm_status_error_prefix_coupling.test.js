/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Cross-repo guard for the raw VM error prefixes that vmFailureStatus
 * collapses into the consensus status vocabulary.
 ********************************************************************/

const assert = require('assert');

process.env.INDEXER_COIN = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const Utility = require('../../../../src/utility.js');
const { siblingsRequired } = require('../../../helpers/sibling_checkout.js');

const EXPECTED_PREFIX_TOKENS = Object.freeze({
    revert: 'reverted',
    out_of_gas: 'out_of_resource',
    timeout: 'out_of_resource',
    out_of_memory: 'out_of_resource',
    out_of_stack: 'out_of_resource',
    out_of_resource: 'out_of_resource',
    error: 'failed'
});
const FROZEN_STATUS_TOKENS = ['reverted', 'out_of_resource', 'failed'];

describe('consensus parameters are frozen (track 8 guard) @regression', function() {
    it('maps every VM STATUS_ERROR_PREFIXES entry to its frozen indexer token', function() {
        let vm;
        try { vm = require('xchain-vm'); }
        catch (e) {
            if (siblingsRequired()) {
                assert.fail('required xchain-vm package did not load for prefix coupling: ' + e.message);
            }
            this.skip();
            return;
        }

        assert.ok(vm.STATUS_ERROR_PREFIXES,
            'xchain-vm did not export STATUS_ERROR_PREFIXES');
        assert.deepStrictEqual([...vm.STATUS_ERROR_PREFIXES].sort(),
            Object.keys(EXPECTED_PREFIX_TOKENS).sort(),
            'VM raw error-prefix set drifted from the indexer expectation');

        const util = new Utility();
        const produced = new Set();
        for (const prefix of vm.STATUS_ERROR_PREFIXES) {
            assert.ok(Object.hasOwn(EXPECTED_PREFIX_TOKENS, prefix),
                'no indexer token golden for VM prefix ' + prefix);
            const got = util.vmFailureStatus(prefix + ': x');
            assert.strictEqual(got, EXPECTED_PREFIX_TOKENS[prefix],
                'vmFailureStatus token drifted for VM prefix ' + prefix);
            assert.ok(FROZEN_STATUS_TOKENS.includes(got),
                'token outside frozen status vocabulary: ' + got);
            produced.add(got);
        }
        assert.deepStrictEqual([...produced].sort(), [...FROZEN_STATUS_TOKENS].sort(),
            'a frozen status token has no VM raw-error prefix');
    });
});

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

const listShare = require('../../../bin/recovery/list_share.js');
const canonical = require('../../../src/consensus/list_share_settle/canonical.js');
const swq = require('../../../src/consensus/stake_weighted_quorum.js');

function rowWith(overrides){
    let row = Object.assign({
        id: 7,
        snapshot_block: 100,
        network: 'regtest',
        home_chain: 'DOGE',
        home_list_index: 5,
        list_type: 2,
        seq: 1,
        kind: 'full',
        origin_block: 90,
        members_hash: 'a'.repeat(64),
        added: JSON.stringify(['addr-a', 'addr-b']),
        removed: '[]',
        admit_block_btc: 104,
        admit_block_ltc: null,
        admit_block_doge: null,
        finalizing_view: 0,
        validator_signatures: '["signature"]',
        status: 'finalized'
    }, overrides || {});
    if(!overrides || !Object.prototype.hasOwnProperty.call(overrides, 'snapshot_id')){
        row.snapshot_id = canonical.deriveListSnapshotId(
            row.network, row.home_chain, row.home_list_index, row.seq, row.snapshot_block);
    }
    return row;
}

function context(accept, calls, overrides){
    return Object.assign({
        network: 'regtest',
        setFor: (capability, block) => {
            calls.push(['setFor', capability, block]);
            return ['validator'];
        },
        parseSigs: value => {
            calls.push(['parseSigs', value]);
            return JSON.parse(value);
        },
        listShareCanonical: row => {
            calls.push(['listShareCanonical', row.snapshot_id]);
            return 'canonical:' + row.snapshot_id;
        },
        quorumVerified: (message, sigs, set, weighted) => {
            calls.push(['quorumVerified', message, sigs, set, weighted]);
            return accept;
        }
    }, overrides || {});
}

describe('list snapshot archive verification @regression @tier1', function () {
    it('verifies a row against its archived cross_chain set', function () {
        let row = rowWith();
        let calls = [];

        listShare.verifyArchive({ list_snapshots: [row] }, context(true, calls));

        assert.deepStrictEqual(calls, [
            ['setFor', 'cross_chain', row.snapshot_block],
            ['parseSigs', row.validator_signatures],
            ['listShareCanonical', row.snapshot_id],
            ['quorumVerified', 'canonical:' + row.snapshot_id, ['signature'], ['validator'],
                swq.isStakeWeightedQuorumActive(row.snapshot_block, row.network)]
        ]);
    });

    it('rejects a row that fails quorum', function () {
        let calls = [];

        assert.throws(
            () => listShare.verifyArchive({ list_snapshots: [rowWith()] },
                context(false, calls)),
            /fails quorum against the archived cross_chain set/
        );
        assert.strictEqual(calls[0][0], 'setFor');
    });

    it('rejects the wrong network before reading the validator set', function () {
        let calls = [];
        let row = rowWith({ network: 'testnet' });

        assert.throws(
            () => listShare.verifyArchive({ list_snapshots: [row] }, context(true, calls)),
            /network/
        );
        assert.deepStrictEqual(calls, []);
    });

    it('accepts an absent or null list_snapshots value without calls', function () {
        let calls = [];
        let ctx = context(true, calls);

        assert.doesNotThrow(() => listShare.verifyArchive({}, ctx));
        assert.doesNotThrow(() => listShare.verifyArchive({ list_snapshots: null }, ctx));
        assert.deepStrictEqual(calls, []);
    });

    it('rejects a present non-array list_snapshots value', function () {
        let calls = [];

        assert.throws(
            () => listShare.verifyArchive({ list_snapshots: {} }, context(true, calls)),
            /malformed list archive rows/
        );
        assert.deepStrictEqual(calls, []);
    });

    it('requires the injected canonical builder before reading any row', function () {
        let calls = [];
        let unread = new Proxy({}, {
            get: () => {
                calls.push(['row read']);
                return undefined;
            }
        });

        assert.throws(
            () => listShare.verifyArchive({ list_snapshots: [unread] },
                context(true, calls, { listShareCanonical: null })),
            /listShareCanonical/
        );
        assert.deepStrictEqual(calls, []);
    });
});

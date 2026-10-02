'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const path = require('path');

const ah = require('../../../src/consensus/gates/mirror_admission_gate.js');
const eq = require('../../../src/consensus/equivocation_header.js');
const { listMembershipHash } = require('../../../src/consensus/list_share_hash.js');
const { createCanonical } = require('../../../src/consensus/list_share_settle/canonical.js');
const { injectListShareLegs } = require('../../../src/consensus/list_share_settle/inject.js');
const { planListShareLegs } = require('../../../src/consensus/list_share_settle/legs.js');
const { verifyMirrorMembers } = require('../../../src/consensus/list_share_settle/reread.js');

require('./parts/list_share_screen_meta.test.js');
require('./parts/list_share_screen_meta_wiring.test.js');
require('./parts/list_share_legs_meta.test.js');
require('./parts/list_share_legs_meta_edit.test.js');
require('./parts/list_share_apply_meta.test.js');
require('./parts/list_share_inject_meta.test.js');
require('../actions/list_wire/list_store_meta.test.js');
require('../actions/contract/list.test/list_rename_no_head.test.js');

const vectors = require(path.resolve(
    __dirname,
    '../../../../xchain-documentation/protocol/test-vectors/list_share.json'
));

function canonicalRow(vector){
    const row = { ...vector, finalizing_view: vector.view };
    for(const [coin, height] of Object.entries(vector.admission || {}))
        row['admit_block_' + coin.toLowerCase()] = height;
    return row;
}

describe('list share metadata consumer integration', function () {
    const base = {
        seq: 2,
        listType: 2,
        added: [],
        removed: [],
        mirrorIndex: 81,
        meta: { name: 'Treasury wallets', description: 'Current treasury set' },
        currentMeta: { name: 'Old treasury', description: 'Current treasury set' },
    };

    it('matches legacy and metadata canonical vectors byte for byte', function () {
        const legacy = createCanonical({ ah, eq, isListMetaActive: () => false })
            .listShareCanonical;
        const active = createCanonical({ ah, eq, isListMetaActive: () => true })
            .listShareCanonical;

        for(const vector of vectors.canonicals)
            assert.strictEqual(legacy(canonicalRow(vector)), vector.expected, vector.name);
        for(const vector of vectors.metaCanonicals)
            assert.strictEqual(active(canonicalRow(vector)), vector.expected, vector.name);
    });

    it('catches up on the next version after an inactive consumer gate', function () {
        assert.deepStrictEqual(planListShareLegs({
            ...base,
            metaActive: false,
        }), []);

        assert.deepStrictEqual(planListShareLegs({
            ...base,
            seq: 3,
            metaActive: true,
        }), [{
            fields: ['LIST', '5', '81', 'Treasury wallets', 'Current treasury set', ''],
            ordinal: 2,
        }]);
    });

    it('injects a clear without changing the mirror head or membership', async function () {
        const members = ['addr-a', 'addr-b'];
        const state = {
            headIndex: 81,
            itemCount: members.length,
            meta: { name: 'Treasury wallets', description: 'Current treasury set' },
            mirrorCreates: 0,
        };
        const legs = planListShareLegs({
            ...base,
            metaActive: true,
            meta: { name: null, description: null },
            currentMeta: state.meta,
        });
        const ctx = {
            blockIndex: 90,
            blockTime: 100,
            actions: {
                async processTransaction(tx, isGenesis){
                    assert.strictEqual(isGenesis, true);
                    assert.strictEqual(tx.data, 'LIST|5|81|-|-|');
                    state.meta = { name: null, description: null };
                    return { ACTION_INDEX: 82, STATUS: 'valid' };
                },
            },
            indexerDb: {
                async createListShareMirror(){
                    state.mirrorCreates += 1;
                },
                async getList(index){
                    assert.strictEqual(index, 81);
                    return members.slice();
                },
            },
        };

        const injected = await injectListShareLegs(ctx, {
            legs,
            snapshotId: 'a'.repeat(64),
            owner: 'bridge-owner',
            homeChain: 'DOGE',
            homeListIndex: 50,
        });
        const reread = await verifyMirrorMembers(ctx.indexerDb, {
            mirrorIndex: state.headIndex,
            blockIndex: ctx.blockIndex,
            membersHash: listMembershipHash(members),
            snapshotId: 'a'.repeat(64),
        });

        assert.deepStrictEqual(injected, { actionIndexes: [82], mirrorIndex: null });
        assert.deepStrictEqual(state.meta, { name: null, description: null });
        assert.strictEqual(state.headIndex, 81);
        assert.strictEqual(state.itemCount, 2);
        assert.strictEqual(state.mirrorCreates, 0);
        assert.deepStrictEqual(reread, members);
    });
});

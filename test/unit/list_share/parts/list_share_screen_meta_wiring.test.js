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

const {
    createScreen,
    screenListSnapshot,
} = require('../../../../src/consensus/list_share_settle/screen.js');
const { deriveListSnapshotId } = require(
    '../../../../src/consensus/list_share_settle/canonical.js'
);
const { listMetaHash } = require('../../../../src/consensus/list_share_hash.js');
const { LIST_SHARE_HALT_REASON } = require(
    '../../../../src/consensus/list_share_settle/halt.js'
);

const ah = {
    columnsAdmitBlocks(row){
        return { BTC: Number(row.admit_block_btc) };
    },
};
const ctx = { coin: 'BTC', network: 'regtest', config: { BTC_CHAIN_ID: 'btc-regtest' } };

function fullRow(overrides = {}){
    const row = Object.assign({
        snapshot_block: 100,
        network: 'regtest',
        home_chain: 'DOGE',
        home_list_index: 5,
        list_type: 2,
        seq: 1,
        kind: 'full',
        origin_block: 90,
        added: JSON.stringify(['a', 'b']),
        removed: JSON.stringify([]),
        status: 'finalized',
        btc_chain_id: 'btc-regtest',
        admit_block_btc: 104,
    }, overrides);
    if(!Object.prototype.hasOwnProperty.call(overrides, 'snapshot_id')){
        row.snapshot_id = deriveListSnapshotId(
            row.network,
            row.home_chain,
            row.home_list_index,
            row.seq,
            row.snapshot_block,
        );
    }
    return row;
}

function legacyFields(row){
    return {
        snapshot_id: row.snapshot_id,
        snapshot_block: 100,
        home_chain: 'DOGE',
        home_list_index: 5,
        list_type: 2,
        seq: 1,
        kind: 'full',
        origin_block: 90,
        added: ['a', 'b'],
        removed: [],
    };
}

describe('list share metadata screen wiring', function () {
    it('screens absent metadata below the gate', function () {
        const row = fullRow();
        const screen = createScreen({ ah, isListMetaActive: () => false }).screenListSnapshot;

        assert.deepStrictEqual(screen(row, ctx), {
            fields: Object.assign(legacyFields(row), {
                name: null,
                description: null,
                meta_hash: null,
            }),
        });

        assert.deepStrictEqual(screen(fullRow({ name: 'Named list' }), ctx), {
            halt: LIST_SHARE_HALT_REASON.META_HASH,
            detail: 'meta_below_gate',
        });
    });

    it('screens valid and forged metadata at the gate', function () {
        const screen = createScreen({ ah, isListMetaActive: () => true }).screenListSnapshot;
        const metadata = { name: 'Named list', description: 'A description' };
        const row = fullRow(Object.assign({}, metadata, {
            meta_hash: listMetaHash(metadata.name, metadata.description),
        }));

        assert.deepStrictEqual(screen(row, ctx), {
            fields: Object.assign(legacyFields(row), metadata, { meta_hash: row.meta_hash }),
        });
        assert.deepStrictEqual(screen(Object.assign({}, row, { meta_hash: 'forged' }), ctx), {
            halt: LIST_SHARE_HALT_REASON.META_HASH,
            detail: 'meta_hash',
        });
    });

    it('preserves legacy screening when the reader is absent', function () {
        const row = fullRow({ name: 'Named list', meta_hash: 'forged' });
        const expected = { fields: legacyFields(row) };

        assert.deepStrictEqual(createScreen({ ah }).screenListSnapshot(row, ctx), expected);
        assert.deepStrictEqual(screenListSnapshot(row, ctx), expected);
    });

    it('calls the reader once with the numeric block and row network', function () {
        const calls = [];
        const screen = createScreen({
            ah,
            isListMetaActive(snapshotBlock, network){
                calls.push([snapshotBlock, network]);
                return false;
            },
        }).screenListSnapshot;

        assert.ok(screen(fullRow({ snapshot_block: '100' }), ctx).fields);
        assert.deepStrictEqual(calls, [[100, 'regtest']]);
    });

    it('does not call the reader after an earlier screen halt', function () {
        let calls = 0;
        const screen = createScreen({
            ah,
            isListMetaActive(){
                calls += 1;
                return true;
            },
        }).screenListSnapshot;

        assert.deepStrictEqual(screen(fullRow({ seq: 'bad' }), ctx), {
            halt: LIST_SHARE_HALT_REASON.SCREEN,
            detail: 'seq',
        });
        assert.strictEqual(calls, 0);
    });
});

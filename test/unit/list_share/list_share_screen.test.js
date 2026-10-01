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
 *********************************************************************/

'use strict';

const assert = require('assert');

const { createScreen } = require('../../../src/consensus/list_share_settle/screen.js');
const { deriveListSnapshotId } = require('../../../src/consensus/list_share_settle/canonical.js');
const { LIST_SHARE_HALT_REASON } = require('../../../src/consensus/list_share_settle/halt.js');

const COINS = ['BTC', 'LTC', 'DOGE'];

function admissionColumns(row){
    const map = {};
    for(const coin of COINS){
        const value = row['admit_block_' + coin.toLowerCase()];
        if(value !== null && value !== undefined)
            map[coin] = Number(value);
    }
    return Object.keys(map).length ? map : null;
}

const ah = { columnsAdmitBlocks: admissionColumns };
const screen = createScreen({ ah }).screenListSnapshot;
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

function assertHalt(row, detail, context = ctx, run = screen){
    assert.deepStrictEqual(run(row, context), {
        halt: LIST_SHARE_HALT_REASON.SCREEN,
        detail,
    });
}

describe('list share snapshot screen', function () {
    it('returns parsed fields for a full snapshot', function () {
        const row = fullRow({
            snapshot_block: '100',
            home_list_index: 5n,
            list_type: '2',
            seq: '1',
            origin_block: '90',
            removed: null,
        });

        assert.deepStrictEqual(screen(row, ctx), {
            fields: {
                snapshot_id: row.snapshot_id,
                snapshot_block: 100,
                home_chain: 'DOGE',
                home_list_index: 5,
                list_type: 2,
                seq: 1,
                kind: 'full',
                origin_block: 90,
                added: ['a', 'b'],
                removed: null,
            }
        });
    });

    it('returns parsed fields for a delta snapshot', function () {
        const row = fullRow({
            seq: 2,
            kind: 'delta',
            added: ['c'],
            removed: JSON.stringify(['a']),
        });

        assert.deepStrictEqual(screen(row, ctx).fields, {
            snapshot_id: row.snapshot_id,
            snapshot_block: 100,
            home_chain: 'DOGE',
            home_list_index: 5,
            list_type: 2,
            seq: 2,
            kind: 'delta',
            origin_block: 90,
            added: ['c'],
            removed: ['a'],
        });
    });

    for(const field of ['snapshot_block', 'home_list_index', 'seq', 'origin_block']){
        it('halts on a non-integer ' + field, function () {
            assertHalt(fullRow({ [field]: '1.5' }), field);
        });
    }

    it('does not coerce other value types into integers', function () {
        assertHalt(fullRow({ snapshot_block: true }), 'snapshot_block');
        assertHalt(fullRow({ home_list_index: [] }), 'home_list_index');
    });

    it('halts when the home chain is unknown or local', function () {
        assertHalt(fullRow({ home_chain: 'ETH' }), 'home_chain');
        assertHalt(fullRow({ home_chain: 'BTC' }), 'home_chain');
    });

    it('halts on a network mismatch', function () {
        assertHalt(fullRow({ network: 'testnet' }), 'network');
    });

    it('halts on a snapshot id mismatch', function () {
        assertHalt(fullRow({ snapshot_id: 'bad' }), 'snapshot_id');
    });

    it('halts when two set BTC chain identities differ', function () {
        assertHalt(fullRow({ btc_chain_id: 'other' }), 'btc_chain_id');
        assert.ok(screen(fullRow({ btc_chain_id: null }), ctx).fields);
        assert.ok(screen(fullRow(), Object.assign({}, ctx, { config: {} })).fields);
    });

    it('halts unless status is finalized', function () {
        assertHalt(fullRow({ status: 'pending' }), 'status');
    });

    it('halts unless list type is 1 or 2', function () {
        assertHalt(fullRow({ list_type: 3 }), 'list_type');
    });

    it('halts unless sequence 1 is full and later sequences are delta', function () {
        assertHalt(fullRow({ kind: 'delta' }), 'kind');
        assertHalt(fullRow({ seq: 2, kind: 'full' }), 'kind');
        assertHalt(fullRow({ seq: 2, kind: 'other' }), 'kind');
    });

    it('halts on malformed added or removed membership', function () {
        assertHalt(fullRow({ added: '{}' }), 'added');
        assertHalt(fullRow({ removed: '{}' }), 'removed');
    });

    it('halts on unordered added or removed membership', function () {
        assertHalt(fullRow({ added: JSON.stringify(['b', 'a']) }), 'added_order');
        assertHalt(fullRow({ removed: JSON.stringify(['b', 'a']), seq: 2, kind: 'delta' }), 'removed_order');
    });

    it('halts when sequence 1 removes a member', function () {
        assertHalt(fullRow({ removed: JSON.stringify(['a']) }), 'removed_seq_1');
    });

    it('halts when admission columns do not name the local chain', function () {
        assertHalt(fullRow({ admit_block_btc: null, admit_block_ltc: 104 }), 'admit_block_btc');
    });

    it('turns an admission-column parser throw into a halt', function () {
        const throwing = createScreen({
            ah: { columnsAdmitBlocks: () => { throw new Error('bad column'); } },
        }).screenListSnapshot;
        assertHalt(fullRow(), 'admit_block_btc', ctx, throwing);
    });

    it('reports the first failed check', function () {
        assertHalt(fullRow({
            snapshot_block: null,
            home_list_index: null,
            status: 'pending',
        }), 'snapshot_block');
    });
});

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

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ah = require('../../../src/consensus/gates/mirror_admission_gate.js');
const eq = require('../../../src/consensus/equivocation_header.js');
const { createCanonical, deriveListSnapshotId } = require('../../../src/consensus/list_share_settle/canonical.js');
const { createScreen } = require('../../../src/consensus/list_share_settle/screen.js');
const { LIST_SHARE_HALT_REASON } = require('../../../src/consensus/list_share_settle/halt.js');
const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');

const DOCS_DIR = process.env.XCHAIN_DOCS_DIR || path.resolve(
    __dirname,
    '../../../../xchain-documentation',
);
const VECTOR_PATH = path.join(DOCS_DIR, 'protocol/test-vectors/list_share.json');

function vectorRows(vector) {
    const row = { ...vector, finalizing_view: vector.view };
    for (const [coin, height] of Object.entries(vector.admission || {}))
        row['admit_block_' + coin.toLowerCase()] = height;
    return row;
}

function fixture(overrides = {}) {
    const row = {
        snapshot_block: 100,
        network: 'regtest',
        home_chain: 'DOGE',
        home_list_index: 5,
        list_type: 2,
        seq: 1,
        kind: 'full',
        origin_block: 90,
        members_hash: 'a'.repeat(64),
        added: JSON.stringify(['a', 'b']),
        removed: JSON.stringify([]),
        status: 'finalized',
        admit_block_btc: 104,
        ...overrides,
    };
    if (!Object.prototype.hasOwnProperty.call(overrides, 'snapshot_id')) {
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

describe('list share pure settle parts', function () {
    it('rebuilds every snapshot id and signed canonical vector byte for byte', function () {
        const verdict = siblingCheckout(__dirname, VECTOR_PATH);
        if (!verdict.usable)
            return skipOrFail(this, verdict, 'the canonical list share vectors');

        const vectors = JSON.parse(fs.readFileSync(VECTOR_PATH, 'utf8'));
        for (const vector of vectors.snapshotIds) {
            assert.strictEqual(
                deriveListSnapshotId(
                    vector.network,
                    vector.homeChain,
                    vector.homeListIndex,
                    vector.seq,
                    vector.snapshotBlock,
                ),
                vector.expected,
                vector.name,
            );
        }

        const canonical = createCanonical({ ah, eq }).listShareCanonical;
        for (const vector of vectors.canonicals)
            assert.strictEqual(canonical(vectorRows(vector)), vector.expected, vector.name);
    });

    it('refuses to canonicalize a list row without an admission map', function () {
        const canonical = createCanonical({ ah, eq }).listShareCanonical;
        assert.throws(() => canonical(fixture({ admit_block_btc: null })), /admission map/);
    });

    it('returns normalized fields for a full snapshot and a delta', function () {
        const screen = createScreen({ ah }).screenListSnapshot;
        const ctx = { coin: 'BTC', network: 'regtest', config: { BTC_CHAIN_ID: 'chain-a' } };
        const full = screen(fixture({ btc_chain_id: 'chain-a' }), ctx);
        assert.deepStrictEqual(full.fields.added, ['a', 'b']);
        assert.deepStrictEqual(full.fields.removed, []);
        assert.strictEqual(full.fields.list_type, 2);

        const delta = fixture({
            seq: '2',
            kind: 'delta',
            origin_block: '91',
            added: JSON.stringify(['c']),
            removed: JSON.stringify(['a']),
        });
        const screenedDelta = screen(delta, ctx);
        assert.strictEqual(screenedDelta.fields.seq, 2);
        assert.deepStrictEqual(screenedDelta.fields.added, ['c']);
        assert.deepStrictEqual(screenedDelta.fields.removed, ['a']);
    });

    it('names every screen failure with the shared SCREEN halt reason', function () {
        const throwingAdmission = {
            columnsAdmitBlocks() { throw new Error('bad admission column'); },
        };
        const ctx = { coin: 'BTC', network: 'regtest', config: { BTC_CHAIN_ID: 'chain-a' } };
        const cases = [
            [fixture({ snapshot_block: '01' }), ctx],
            [fixture({ home_list_index: -1 }), ctx],
            [fixture({ seq: 1.5 }), ctx],
            [fixture({ origin_block: null }), ctx],
            [fixture({ home_chain: 'ETH' }), ctx],
            [fixture({ home_chain: 'BTC' }), ctx],
            [fixture({ network: 'testnet' }), ctx],
            [fixture({ snapshot_id: 'wrong' }), ctx],
            [fixture({ btc_chain_id: 'chain-b' }), ctx],
            [fixture({ status: 'pending' }), ctx],
            [fixture({ list_type: 3 }), ctx],
            [fixture({ kind: 'delta' }), ctx],
            [fixture({ added: '{' }), ctx],
            [fixture({ added: JSON.stringify(['b', 'a']) }), ctx],
            [fixture({ removed: '{' }), ctx],
            [fixture({ removed: JSON.stringify(['b', 'a']) }), ctx],
            [fixture({ removed: JSON.stringify(['a']) }), ctx],
            [fixture({ admit_block_btc: null }), ctx],
        ];
        const screen = createScreen({ ah }).screenListSnapshot;
        for (const [row, context] of cases) {
            const result = screen(row, context);
            assert.strictEqual(result.halt, LIST_SHARE_HALT_REASON.SCREEN, result.detail);
            assert.strictEqual(typeof result.detail, 'string');
        }

        const thrown = createScreen({ ah: throwingAdmission }).screenListSnapshot(fixture(), ctx);
        assert.strictEqual(thrown.halt, LIST_SHARE_HALT_REASON.SCREEN);
    });
});

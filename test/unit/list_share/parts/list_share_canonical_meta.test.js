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

const ah = require('../../../../src/consensus/gates/mirror_admission_gate.js');
const eq = require('../../../../src/consensus/equivocation_header.js');
const { createCanonical } = require('../../../../src/consensus/list_share_settle/canonical.js');
const { siblingCheckout, skipOrFail } = require('../../../helpers/sibling_checkout.js');

const DOCS_DIR = process.env.XCHAIN_DOCS_DIR || path.resolve(
    __dirname,
    '../../../../../xchain-documentation',
);
const VECTOR_PATH = path.join(DOCS_DIR, 'protocol/test-vectors/list_share.json');

function readVectors(ctx) {
    const verdict = siblingCheckout(__dirname, VECTOR_PATH);
    if (!verdict.usable)
        return skipOrFail(ctx, verdict, 'the canonical list share metadata vectors');
    return JSON.parse(fs.readFileSync(VECTOR_PATH, 'utf8'));
}

function vectorRows(vector) {
    const row = { ...vector, finalizing_view: vector.view };
    for (const [coin, height] of Object.entries(vector.admission || {}))
        row['admit_block_' + coin.toLowerCase()] = height;
    return row;
}

describe('list share canonical metadata', function () {
    it('appends the metadata hash to every canonical at the metadata gate', function () {
        const vectors = readVectors(this);
        if (!vectors) return;

        const canonical = createCanonical({ ah, eq, isListMetaActive: () => true })
            .listShareCanonical;
        for (const vector of vectors.metaCanonicals)
            assert.strictEqual(canonical(vectorRows(vector)), vector.expected, vector.name);
    });

    it('canonicalizes absent and null metadata hashes as an empty field', function () {
        const vectors = readVectors(this);
        if (!vectors) return;

        const vector = vectors.metaCanonicals.find(({ meta_hash }) => meta_hash === '');
        assert.ok(vector, 'without-metadata canonical vector');
        const canonical = createCanonical({ ah, eq, isListMetaActive: () => true })
            .listShareCanonical;
        const absent = vectorRows(vector);
        delete absent.meta_hash;
        assert.strictEqual(canonical(absent), vector.expected);
        assert.strictEqual(canonical({ ...absent, meta_hash: null }), vector.expected);
        assert.ok(vector.expected.endsWith('|'));
    });

    it('preserves every legacy canonical when the reader is false or absent', function () {
        const vectors = readVectors(this);
        if (!vectors) return;

        const inactive = createCanonical({ ah, eq, isListMetaActive: () => false })
            .listShareCanonical;
        const absent = createCanonical({ ah, eq }).listShareCanonical;
        for (const vector of vectors.canonicals) {
            const row = vectorRows(vector);
            assert.strictEqual(inactive(row), vector.expected, vector.name + ' inactive');
            assert.strictEqual(absent(row), vector.expected, vector.name + ' absent');
        }
    });

    it('reads metadata activation at the row snapshot block and network', function () {
        const vectors = readVectors(this);
        if (!vectors) return;

        const vector = vectors.metaCanonicals[0];
        const calls = [];
        const canonical = createCanonical({
            ah,
            eq,
            isListMetaActive(snapshotBlock, network) {
                calls.push([snapshotBlock, network]);
                return true;
            },
        }).listShareCanonical;
        canonical(vectorRows(vector));
        assert.deepStrictEqual(calls, [[vector.snapshot_block, vector.network]]);
    });
});

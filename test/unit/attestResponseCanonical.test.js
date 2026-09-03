/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const can = require('../../src/attest_response_canonical.js');

const BASE = {
    requestId:    'a'.repeat(64),
    providerId:   'http_get',
    responseHash: 'b'.repeat(64),
    status:       'ok'
};

describe('attest_response_canonical', function () {

    it('reproduces the legacy five-field concatenation byte for byte when no effective time is given', function () {
        const meta = 'status=200';
        const expected = BASE.requestId + BASE.providerId + BASE.responseHash + BASE.status + meta;
        assert.strictEqual(can.buildResponseCanonicalRaw(Object.assign({}, BASE, { meta })), expected);
        // null and undefined both mean "legacy era", because the two arrive from
        // different places: an absent column reads undefined, a column the producer
        // deliberately left empty reads null.
        assert.strictEqual(can.buildResponseCanonicalRaw(Object.assign({}, BASE, { meta, effectiveTime: null })), expected);
        assert.strictEqual(can.buildResponseCanonicalRaw(Object.assign({}, BASE, { meta, effectiveTime: undefined })), expected);
    });

    it('treats a missing meta as the empty string, as the legacy canonical does', function () {
        const expected = BASE.requestId + BASE.providerId + BASE.responseHash + BASE.status;
        assert.strictEqual(can.buildResponseCanonicalRaw(BASE), expected);
        assert.strictEqual(can.buildResponseCanonicalRaw(Object.assign({}, BASE, { meta: null })), expected);
        assert.strictEqual(can.buildResponseCanonicalRaw(Object.assign({}, BASE, { meta: '' })), expected);
    });

    it('appends the effective time behind a separator in the mirror era', function () {
        assert.strictEqual(
            can.buildResponseCanonicalRaw(Object.assign({}, BASE, { meta: 'X', effectiveTime: 1234 })),
            BASE.requestId + BASE.providerId + BASE.responseHash + BASE.status + 'X|1234');
    });

    // THE REASON THE SEPARATOR EXISTS. `meta` is free-form provider text and was
    // safe as the trailing field precisely because nothing followed it. Appended
    // bare, one honest quorum's signature would validate against two different
    // effective times, and the verifier rebuilds the canonical from a row it does
    // not trust, so the producer would get to pick which. That is a producer-chosen
    // shift in the block the callback fires at, which is the exact authority this
    // design takes away from producers.
    it('does not let meta and the effective time trade bytes', function () {
        const a = can.buildResponseCanonicalRaw(Object.assign({}, BASE, { meta: 'X',  effectiveTime: 1234 }));
        const b = can.buildResponseCanonicalRaw(Object.assign({}, BASE, { meta: 'X1', effectiveTime: 234  }));
        assert.notStrictEqual(a, b, 'the shifted reading must not produce the same canonical bytes');
        // Prove the collision is real WITHOUT the separator, so this test fails for
        // the right reason if someone ever removes it.
        const bare = (m, e) => BASE.requestId + BASE.providerId + BASE.responseHash + BASE.status + m + String(e);
        assert.strictEqual(bare('X', 1234), bare('X1', 234), 'the bare concatenation is ambiguous, which is why it is not used');
    });

    it('rejects a non-canonical integer spelling rather than producing unrebuildable bytes', function () {
        for (const bad of ['0120', '+1', '-1', '1.0', ' 1', '1 ', '1e3', '', 'abc', '01', true, {}, [], -1, 1.5, NaN]) {
            assert.throws(
                () => can.buildResponseCanonicalRaw(Object.assign({}, BASE, { meta: '', effectiveTime: bad })),
                /canonical integer spelling/,
                'accepted ' + JSON.stringify(bad));
        }
    });

    it('accepts both the number and the string spelling of the same canonical integer, identically', function () {
        assert.strictEqual(
            can.buildResponseCanonicalRaw(Object.assign({}, BASE, { meta: '', effectiveTime: 0 })),
            can.buildResponseCanonicalRaw(Object.assign({}, BASE, { meta: '', effectiveTime: '0' })));
        assert.strictEqual(
            can.buildResponseCanonicalRaw(Object.assign({}, BASE, { meta: '', effectiveTime: 1788000000 })),
            can.buildResponseCanonicalRaw(Object.assign({}, BASE, { meta: '', effectiveTime: '1788000000' })));
    });

    it('classifies canonical integer spellings the way the relay guard does', function () {
        assert.strictEqual(can.isCanonicalIntSpelling('0'), true);
        assert.strictEqual(can.isCanonicalIntSpelling('120'), true);
        assert.strictEqual(can.isCanonicalIntSpelling(120), true);
        assert.strictEqual(can.isCanonicalIntSpelling('0120'), false);
        assert.strictEqual(can.isCanonicalIntSpelling('1|2'), false);
        assert.strictEqual(can.isCanonicalIntSpelling(null), false);
    });
});

describe('attest_response_canonical: hub/indexer twin', function () {

    const HUB_COPY = path.resolve(__dirname, '../../../xchain-hub/src/attest_response_canonical.js');

    it('produces byte-identical canonicals to the hub copy across both eras', function () {
        if (!fs.existsSync(HUB_COPY)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                assert.fail('xchain-hub sibling checkout missing: ' + HUB_COPY);
            this.skip();
            return;
        }
        const hub = require(HUB_COPY);
        for (const meta of ['', 'X', 'status=200', 'a|b', '1234', null]) {
            for (const et of [null, 0, 1, 1788000000, '42']) {
                const fields = Object.assign({}, BASE, { meta, effectiveTime: et });
                assert.strictEqual(hub.buildResponseCanonicalRaw(fields),
                                   can.buildResponseCanonicalRaw(fields),
                                   'divergence at meta=' + JSON.stringify(meta) + ' effectiveTime=' + JSON.stringify(et));
            }
        }
        assert.strictEqual(hub.MIRROR_FIELD_SEPARATOR, can.MIRROR_FIELD_SEPARATOR);
    });

    it('rejects the same spellings as the hub copy', function () {
        if (!fs.existsSync(HUB_COPY)) { this.skip(); return; }
        const hub = require(HUB_COPY);
        for (const v of ['0120', '+1', '1.0', '', 'abc', '0', '7', 7, -1]) {
            assert.strictEqual(hub.isCanonicalIntSpelling(v), can.isCanonicalIntSpelling(v),
                               'disagreement on ' + JSON.stringify(v));
        }
    });
});

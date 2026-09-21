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
 **********************************************************************
 *
 * The attest-response canonical twin under the mirror-admission flag day: the two-era
 * bytes with no request block, the pre-train bytes below the activation, the appended
 * request-block-keyed map above it, and legacy binding at both version seams, all compared
 * byte for byte against the hub builder when the sibling is trusted.
 * Part of the suite whose entry is test/unit/admission_binding.test.js.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const eq = require('../../../../src/consensus/equivocation_header.js');
const { NETWORK, load, ARMS } = require('./helpers/arms.js');
const { sha } = require('./helpers/rail_fixtures.js');

const RID  = 'r'.repeat(64);
const BODY = Buffer.from('the attested body', 'utf8');
const BASE = { requestId: RID, providerId: 'http_get', responseHash: sha('the attested body'), status: 'ok', meta: 'status=200' };

// The hub's builder on a stub carrying only what it reads; the era gate and the
// round-pinned default come from the real prototype.
function hubCanonical(h, requestBlock, effectiveTime, admitBlocks, network) {
    const A = h.hub.Attest.prototype;
    const self = { hub: { network: network || NETWORK }, pending: null,
                   isMirrorEra: A.isMirrorEra, roundAdmitBlocks: A.roundAdmitBlocks };
    return A.buildCanonical.call(self, RID, BASE.providerId, BODY, BASE.status, BASE.meta,
                                  requestBlock, effectiveTime, admitBlocks).toString('utf8');
}
// The indexer side, wrapped exactly as attest_response_verify.js wraps it.
function indexerCanonical(h, fields, requestBlock, network) {
    let raw = h.can.buildResponseCanonicalRaw(fields);
    return eq.isEquivHeaderActive(requestBlock, network || NETWORK)
        ? eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RID, 0, raw) : raw;
}

describe('admission binding: the attest-response canonical twin', function () {

    for (const arm of ARMS) {
        describe(arm.name, function () {
            let h;
            before(function () { h = load(arm.activation); });
            after(function () { if (h) h.restore(); h = null; });

            it('with no requestBlock the bytes are the two-era form unchanged (the twin stays output-identical)', function () {
                const legacy = h.can.buildResponseCanonicalRaw(Object.assign({}, BASE));
                assert.strictEqual(legacy, RID + BASE.providerId + BASE.responseHash + BASE.status + BASE.meta);
                const mirror = h.can.buildResponseCanonicalRaw(Object.assign({}, BASE, { effectiveTime: 1234 }));
                assert.strictEqual(mirror, legacy + '|1234');
                if (h.hub) {
                    const hubTwin = require('../../../../../xchain-hub/src/attestation/attest_response_canonical.js');
                    assert.strictEqual(hubTwin.buildResponseCanonicalRaw(Object.assign({}, BASE, { effectiveTime: 1234 })), mirror);
                }
            });

            // Below the admission activation in this arm. When armed at 0 no regtest height is
            // below it, so those cases run on mainnet, where the response mirror is ALSO inert
            // and the request is therefore in the legacy attest era (no effective time at all).
            const legacyBlock = (arm.legacyBlock !== null) ? arm.legacyBlock : 5;
            const legacyNet   = (arm.legacyBlock !== null) ? NETWORK : 'mainnet';
            const legacyEt    = (arm.legacyBlock !== null) ? 1234 : null;
            const legacyTail  = (arm.legacyBlock !== null) ? '|1234' : BASE.meta;

            it('a request below the activation with no map rebuilds the pre-train bytes exactly as the hub does', function () {
                const got = indexerCanonical(h, Object.assign({}, BASE, { effectiveTime: legacyEt, network: legacyNet, requestBlock: legacyBlock, admitBlocks: null }), legacyBlock, legacyNet);
                assert.ok(got.endsWith(legacyTail), 'no admission field below the activation: ' + got.slice(-40));
                if (h.hub) assert.strictEqual(got, hubCanonical(h, legacyBlock, legacyEt, null, legacyNet));
            });

            it('a request below the activation handed a map uses legacy bytes', function () {
                const expected = h.can.buildResponseCanonicalRaw(Object.assign({}, BASE, { effectiveTime: legacyEt, network: legacyNet, requestBlock: legacyBlock, admitBlocks: null }));
                const got = h.can.buildResponseCanonicalRaw(Object.assign({}, BASE, { effectiveTime: legacyEt, network: legacyNet, requestBlock: legacyBlock, admitBlocks: { BTC: legacyBlock + 1 } }));
                assert.strictEqual(got, expected);
                if (h.hub) assert.strictEqual(hubCanonical(h, legacyBlock, legacyEt, { BTC: legacyBlock + 1 }, legacyNet),
                    hubCanonical(h, legacyBlock, legacyEt, null, legacyNet));
            });

            it('the spelling guard on effective_time still throws before any admission field is considered', function () {
                assert.throws(() => h.can.buildResponseCanonicalRaw(Object.assign({}, BASE, { effectiveTime: '0120', network: NETWORK, requestBlock: 5, admitBlocks: null })),
                    /canonical integer spelling/);
            });
        });
    }
});

describe('admission binding: the attest-response canonical twin', function () {

    for (const arm of ARMS) {
        describe(arm.name, function () {
            let h;
            before(function () { h = load(arm.activation); });
            after(function () { if (h) h.restore(); h = null; });

            if (arm.modernBlock !== null) {
                it('an admission-era request appends the request-block-keyed map after the effective time, equal to the hub', function () {
                    const fields = Object.assign({}, BASE, { effectiveTime: 1234, network: NETWORK, requestBlock: arm.modernBlock, admitBlocks: { BTC: arm.modernBlock + 1 } });
                    const got = indexerCanonical(h, fields, arm.modernBlock);
                    assert.ok(got.endsWith('|1234|BTC:' + (arm.modernBlock + 1)), got.slice(-40));
                    // Guarded like its neighbours: with no trusted hub twin only the indexer side runs.
                    if (h.hub) assert.strictEqual(got, hubCanonical(h, arm.modernBlock, 1234, { BTC: arm.modernBlock + 1 }));
                    // The map read back off a mirrored row's column is the same map.
                    const fromRow = h.act.columnsAdmitBlocks({ admit_block_btc: arm.modernBlock + 1 });
                    assert.strictEqual(indexerCanonical(h, Object.assign({}, fields, { admitBlocks: fromRow }), arm.modernBlock), got);
                });

                it('an admission-era request with no map uses legacy bytes on both sides', function () {
                    const expected = RID + BASE.providerId + BASE.responseHash + BASE.status + BASE.meta + '|1234';
                    assert.strictEqual(h.can.buildResponseCanonicalRaw(Object.assign({}, BASE, { effectiveTime: 1234, network: NETWORK, requestBlock: arm.modernBlock })), expected);
                    assert.strictEqual(h.can.buildResponseCanonicalRaw(Object.assign({}, BASE, { effectiveTime: 1234, network: NETWORK, requestBlock: arm.modernBlock, admitBlocks: null })), expected);
                    if (h.hub) assert.ok(hubCanonical(h, arm.modernBlock, 1234, null).endsWith(expected));
                    // A legacy row read back off the columns is null, selecting the same bytes.
                    assert.strictEqual(h.act.columnsAdmitBlocks({ admit_block_btc: null }), null);
                });
            }
        });
    }
});

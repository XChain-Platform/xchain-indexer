// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// THE MIRROR-ERA SEAM, SELECTOR AGAINST HANDLER.
//
// The applier pass picks requests in utility/attest_mirror/attest_mirror_select.js, and the ATTEST
// handler gates the same requests through isMirrorEraRequest in actions/attest/response.js.
// Both read the response-mirror row on the request's own block, but each spells the read
// out itself. If one side ever changes alone, the selector picks requests the applier then
// refuses (stranded until the deadline) or skips ones the chain path already treats as
// mirror-era. This file drives both through the REAL registry at and around each network's
// height and requires the same verdict.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');

const Utility = require('../../../src/utility.js');
const response = require('../../../src/actions/attest/response.js');
const gateRegistry = require('../../../src/consensus/gate_registry');
const RESPONSE_MIRROR_KEY = 'attest_response_mirror_activation.ATTEST_RESPONSE_MIRROR_ACTIVATION';

const REQ_ID = 'e'.repeat(64);
const BODY   = 'hello';

// The heights the selector and the handler are compared at, per network. Mainnet is
// unratified (null), so every height there must read as outside the era on both sides.
const CASES = {
    testnet: { height: 151324, blocks: [151323, 151324, 151325, null] },
    regtest: { height: 0,      blocks: [0, 1, null] },
    mainnet: { height: null,   blocks: [0, 1, 900000, null] },
};

function requestRow(blockIndex) {
    return {
        request_id:     REQ_ID,
        action_index:   1,
        provider_id:    'http_get',
        request_status: 'pending',
        deadline_block: 99999999,
        block_index:    blockIndex,
    };
}

function mirrorRow() {
    return {
        request_id:       REQ_ID,
        provider_id:      'http_get',
        status:           'ok',
        response_payload: BODY,
        response_hash:    crypto.createHash('sha256').update(Buffer.from(BODY, 'utf8')).digest('hex'),
        meta:             'm',
        effective_time:   1700000000,
        signer_pubkeys:   '[]',
        signatures:       '[]',
        widen:            0,
    };
}

// The handler's verdict: the seam method, called the way the ATTEST mixin calls it.
function handlerVerdict(network, blockIndex) {
    return response.isMirrorEraRequest.call({ config: { NETWORK: network } }, requestRow(blockIndex));
}

// The selector's verdict: does the applier pass pick this request at a block far above it?
function selectorVerdict(util, network, blockIndex) {
    let picked = util.selectApplicableAttestationResponses(
        [mirrorRow()], [requestRow(blockIndex)], 99999998, 1700000100, network);
    return picked.length === 1;
}

describe('ATTEST mirror-era seam: selector and handler agree on every network', function () {
    let util;
    beforeEach(function () { util = new Utility(); });

    it('reads the activation heights this file was written against', function () {
        // If the operator re-arms a network these cases would silently test something else.
        let row = gateRegistry.get(RESPONSE_MIRROR_KEY);
        for (let [network, c] of Object.entries(CASES))
            assert.strictEqual(row[network], c.height, network + ' mirror height moved; update CASES');
    });

    for (let [network, c] of Object.entries(CASES)) {
        it('gives the same verdict on ' + network + ' at ' + JSON.stringify(c.blocks), function () {
            let seen = [];
            for (let blockIndex of c.blocks) {
                let h = handlerVerdict(network, blockIndex);
                let s = selectorVerdict(util, network, blockIndex);
                assert.strictEqual(s, h, network + ' block ' + JSON.stringify(blockIndex) +
                    ': selector ' + s + ' but isMirrorEraRequest ' + h);
                seen.push(h);
            }
            // Each armed network must exercise BOTH verdicts, so agreement is not two falses.
            if (c.height !== null) assert.deepStrictEqual([...new Set(seen)].sort(), [false, true]);
            else assert.deepStrictEqual([...new Set(seen)], [false]);
        });
    }
});

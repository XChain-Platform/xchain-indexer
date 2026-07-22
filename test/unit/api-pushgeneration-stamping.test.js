/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Source-chain reorg fence (push_generation) stamping on the federation
 * read handlers the hub pins against.
 *
 * Three handlers feed a hub-side generation pin:
 *   getopencrosschainorders   -> CrossChainDexEngine.validateProposedMatch (per leg)
 *   getpendingcrosschaincalls -> the leader stamps the proposed dispatch row
 *   getcrosschaincall         -> CrossChainCallEngine._validateDispatch (follower)
 *
 * The hub compares `Number(x.push_generation) || 0` on both sides, so a handler
 * that omits the field does not error: the follower silently re-derives 0. That
 * matches the leader only until the first rollback on that chain bumps the
 * generation (db.bumpPushGeneration), after which every honest dispatch round is
 * refused by every follower, forever, and all XCALL relay on that chain stalls.
 * getcrosschaincall shipped exactly that omission (review item 2367).
 *
 * Two properties are guarded here:
 *   1. the field is actually emitted (checked by EXECUTING the real response
 *      literal, not by grepping for the identifier), and
 *   2. the generation is read BEFORE the rows (HUB-RETRACT-1). A rollback bumps
 *      the generation atomically with deleting the orphaned rows, so gen-first is
 *      safe wherever that commit lands; rows-then-gen could read a pre-commit
 *      orphan and stamp it with the post-commit generation, letting it escape the
 *      retraction fence permanently.
 *
 * startApi() runs at module load, so src/api.js cannot be required; this reads the
 * source the same way api-auth-batch.test.js and api-federation-read-isolation.test.js
 * do, then compiles the response literal so the shape assertion is a real execution.
 *********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const API_PATH = path.join(__dirname, '../../src/api.js');
const API_SRC  = fs.readFileSync(API_PATH, 'utf8');

// Slice one JSON-RPC handler body out of the controller object literal.
function handlerBody(name) {
    const start = API_SRC.indexOf('async ' + name + '(');
    assert.ok(start !== -1, 'handler not found in src/api.js: ' + name);
    const rel = API_SRC.slice(start + 1).search(/\n {8}async\s+\w+\s*\(/);
    return API_SRC.slice(start, rel === -1 ? API_SRC.length : start + 1 + rel);
}

// Brace-match an object literal starting at the `{` that follows `anchor`.
function objectLiteralAfter(body, anchorRe) {
    const hit = anchorRe.exec(body);
    assert.ok(hit, 'anchor not found: ' + anchorRe);
    const open = body.indexOf('{', hit.index);
    let depth = 0;
    for (let i = open; i < body.length; i++) {
        if (body[i] === '{') depth++;
        else if (body[i] === '}' && --depth === 0) return body.slice(open, i + 1);
    }
    throw new Error('unbalanced object literal for anchor ' + anchorRe);
}

// The generation-stamping handlers, with the row accessor that must come AFTER
// the getPushGeneration read.
const STAMPERS = [
    { name: 'getopencrosschainorders',   rowAccessor: 'getOpenCrossChainOffers(' },
    { name: 'getpendingcrosschaincalls', rowAccessor: 'getPendingCrossChainCallRequests(' },
    { name: 'getcrosschaincall',         rowAccessor: 'getCrossChainCallRequestById(' }
];

describe('push_generation stamping on hub-pinned federation reads (item 2367) @regression', function () {

    STAMPERS.forEach(function (h) {
        describe(h.name, function () {
            const body = handlerBody(h.name);

            it('reads the source-chain push generation', function () {
                assert.ok(body.includes('getPushGeneration('),
                    h.name + ' does not read getPushGeneration; the hub pins this response\'s '
                    + 'push_generation and will re-derive 0 for every row');
            });

            it('reads the generation BEFORE the rows (HUB-RETRACT-1 ordering)', function () {
                const gen = body.indexOf('getPushGeneration(');
                const row = body.indexOf(h.rowAccessor);
                assert.ok(row !== -1, h.name + ' no longer calls ' + h.rowAccessor
                    + '; update this guard to name the new row accessor');
                assert.ok(gen !== -1 && gen < row,
                    h.name + ' must read getPushGeneration BEFORE ' + h.rowAccessor
                    + ': reading rows first can stamp a pre-commit orphaned row with the '
                    + 'post-rollback generation, letting it escape the retraction fence');
            });
        });
    });

    describe('getcrosschaincall response shape', function () {
        // Execute the handler's own success-response literal. It is a pure projection of
        // (indexer.config, latest, row, pushGeneration), so it needs no DB or express.
        const literal = objectLiteralAfter(handlerBody('getcrosschaincall'),
            /return\s*\{\s*[\r\n]?\s*exists:\s*true,/);
        const build = new Function('indexer', 'latest', 'row', 'pushGeneration',
            'return (' + literal + ');');

        // Shaped like getCrossChainCallRequestById's `SELECT x.* FROM xcalls` row.
        const row = {
            call_id: 'c'.repeat(64), action_index: 41, block_index: 100, contract_index: 5,
            target_chain: 'DOGE', target_contract_index: 99, method: 'onArrival',
            params_json: '["x"]', gas_limit: 50000, cross_hops: 1, deadline_block: 4000,
            request_status: 'pending'
        };
        const res = build({ config: { NETWORK: 'regtest' } }, 200, row, 7);

        it('stamps push_generation on the returned call', function () {
            assert.strictEqual(res.call.push_generation, 7,
                'the follower-side dispatch pin (xchain-hub CrossChainCallEngine._validateDispatch) '
                + 'compares call.push_generation; omitting it wedges XCALL relay on any chain that '
                + 'has rolled back at least once');
        });

        it('still carries every other field the hub pin compares', function () {
            for (const f of ['call_id', 'action_index', 'block_index', 'source_contract_index',
                             'target_chain', 'target_contract_index', 'method', 'params_json',
                             'gas_limit', 'cross_hops'])
                assert.ok(Object.prototype.hasOwnProperty.call(res.call, f),
                    'getcrosschaincall dropped ' + f + ', which _validateDispatch compares');
        });
    });
});

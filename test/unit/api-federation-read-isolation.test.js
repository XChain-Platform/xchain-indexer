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
 * Federation READ isolation ( / H2 residual).
 *
 * H2 moved the pushvalidatorrewards WRITE off the block's ACID transaction by
 * routing it through indexerDb.apiView() (an independent pooled connection). The
 * residual: every federation READ handler still resolved through doQuery ->
 * getConnection(), which returns the block's open transactionConnection while a
 * block is mid-process. Two hazards: (1) the read shares one physical connection
 * with the block loop's commit/rollback (per-block atomicity break), and (2) it
 * reads the block's uncommitted rows, so a hub can be handed a validator set /
 * order book the block may still roll back on a reorg or throw.
 *
 * startApi() is not importable (it opens DB connections), so this is a static
 * guard over src/api.js source (the same reconstruction technique as
 * api-auth-batch.test.js and the escrow-negation source-scan guard): every
 * federation-read handler must obtain its DB via .apiView() and must NOT call a
 * bare indexer.indexerDb.<accessor> / indexer.decoderDb.<accessor> read. Runtime
 * proof that apiView() actually routes off the transaction connection lives in
 * db.queries.test.js (write + read accessors) and stake-source.test.js.
 *********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const API_SRC = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');

// Parse the authoritative FEDERATION_READ_METHODS set straight from the source so
// this guard tracks the real gate list instead of a hand-maintained copy.
function parseFederationReadMethods(src) {
    const m = src.match(/const\s+FEDERATION_READ_METHODS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(m, 'FEDERATION_READ_METHODS set not found in src/api.js');
    const names = [];
    const re = /['"]([a-z0-9_]+)['"]/gi;
    let hit;
    while ((hit = re.exec(m[1])) !== null) names.push(hit[1]);
    assert.ok(names.length >= 10, 'expected the full federation-read set, got ' + names.length);
    return names;
}

// Slice out each JSON-RPC handler body: everything from its `async NAME(` header
// up to the next handler header (or the end of the controller object).
function extractHandlerBodies(src) {
    const decl = /\n {8}async\s+(\w+)\s*\(/g;
    const starts = [];
    let m;
    while ((m = decl.exec(src)) !== null) starts.push({ name: m[1], index: m.index });
    const bodies = {};
    for (let i = 0; i < starts.length; i++) {
        const end = (i + 1 < starts.length) ? starts[i + 1].index : src.length;
        bodies[starts[i].name] = src.slice(starts[i].index, end);
    }
    return bodies;
}

describe('federation READ connection isolation  @regression @tier1', function () {
    const federationReads = parseFederationReadMethods(API_SRC);
    const bodies = extractHandlerBodies(API_SRC);

    // getstakesourcebypubkey delegates its whole implementation to
    // src/stake-source.js (getStakeSourceByPubkey), which is where the apiView()
    // routing and its own runtime test live; it has no inline DB access to guard.
    const DELEGATED = new Set(['getstakesourcebypubkey']);

    it('every federation-read method has a handler in the controller', function () {
        for (const name of federationReads)
            assert.ok(bodies[name], 'no handler found for federation-read method: ' + name);
    });

    it('getstakesourcebypubkey delegates to stake-source.js (apiView routing lives there)', function () {
        assert.match(bodies['getstakesourcebypubkey'], /getStakeSourceByPubkey\s*\(\s*indexer/,
            'getstakesourcebypubkey must delegate to getStakeSourceByPubkey(indexer, ...)');
    });

    for (const name of federationReads) {
        if (DELEGATED.has(name)) continue;

        it(name + ' resolves its DB through apiView()', function () {
            assert.match(bodies[name], /\.apiView\(\)/,
                name + ' must obtain its DB via indexer.indexerDb.apiView() / indexer.decoderDb.apiView()');
        });

        it(name + ' makes no bare indexerDb/decoderDb read call (would join the block tx)', function () {
            const body = bodies[name];
            // A read accessor off the raw db routes through getConnection() -> the
            // block's transactionConnection. The only permitted `.` after the db
            // handle is `.apiView()`. (The readiness guard `if(!indexer.indexerDb)`
            // has no trailing dot, so it never matches.)
            const bareIndexer = /indexer\.indexerDb\.(?!apiView\b)/.exec(body);
            assert.ok(!bareIndexer, name + ' calls a bare indexer.indexerDb.' +
                (bareIndexer ? bareIndexer.input.slice(bareIndexer.index + 'indexer.indexerDb.'.length, bareIndexer.index + 40) : '') +
                ' - route it through apiView()');
            const bareDecoder = /indexer\.decoderDb\.(?!apiView\b)/.exec(body);
            assert.ok(!bareDecoder, name + ' calls a bare indexer.decoderDb.<accessor> - route it through apiView()');
        });
    }

    // #3873: the handler's own comment claims its eligibility rule is byte-identical to
    // actions/nodeproof.js `_eligibleVerifierSet`, and the hub sizes quorum off this RPC.
    // Both now resolve the capability side through ONE getValidatorsByCapability read,
    // re-probing per pubkey only on a truncated result. Guarded as a pair so the api
    // copy cannot drift back to a per-pubkey loop while nodeproof.js stays batched.
    it('getfullnodeverifiers intersects via a batched capability read, like nodeproof.js', function () {
        const handler = bodies['getfullnodeverifiers'];
        assert.match(handler, /getValidatorsByCapability\('full_node', blk\)/,
            'getfullnodeverifiers must resolve the capability set in one read');
        assert.match(handler, /capSet \? capSet\.has\(pk\) : await db\.hasCapability\(/,
            'the per-pubkey probe must survive ONLY as the truncated-read fallback');
        const nodeproofSrc = fs.readFileSync(path.join(__dirname, '../../src/actions/nodeproof.js'), 'utf8');
        assert.match(nodeproofSrc, /getValidatorsByCapability\('full_node', blockIndex\)/,
            'nodeproof.js _eligibleVerifierSet must use the same batched read');
        assert.match(nodeproofSrc, /capSet \? capSet\.has\(pk\) : await this\.indexerDb\.hasCapability\(/,
            'nodeproof.js must keep the same truncated-read fallback');
    });
});

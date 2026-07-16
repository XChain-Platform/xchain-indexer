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
 **********************************************************************
 * test/unit/blockhash-conformance-twin.test.js
 *
 * Static drift-lock for the consensus block-hash CONFORMANCE PAIR ,
 * reciprocal side: xchain-sync carries the same test, but that copy only runs
 * in sync CI, so an indexer-side edit to the hashing inputs would ship green
 * here and only redden when sync CI next runs with a sibling checkout (the
 * same one-directional hole the whole-file twin guard in
 * rollback-coverage.test.js closes for merkle.js and friends).
 *
 * xchain-sync/src/BlockHasher.js computeBlockHashes() is a hand-ported twin of
 * xchain-indexer/src/db.js getBlockHashes(): same consensus SELECTs, same
 * special-address canonicalization, same chaining/version fold, hashed through
 * the same getDataHash/jsonStringify pair. The two live inside DIFFERENT host
 * structures (a db.js method vs a sync class), so whole-file byte-identity
 * cannot apply. This test extracts the consensus-bearing pieces from BOTH
 * repos' sources and asserts them equal after stripping comments and
 * collapsing whitespace:
 *
 *   1. BLOCK_HASH_VERSION
 *   2. every consensus SQL literal, in gathering order (credits, debits,
 *      escrows, actions, contracts, contract_state, executions, emissions,
 *      deposits, withdrawals, previous-block hashes)
 *   3. the BURN/GAS/DONATE/REWARD canonicalization loops
 *   4. the hash-assembly tail (block_index / previous_hash / hash_version fold)
 *   5. utility jsonStringify + getDataHash (the shared preimage serializer)
 *   6. stateCommitment.js reportOrphanStats (documented byte-identical twin
 *      with no prior comparison test)
 *
 * A one-sided edit to any of these forks every sync validator's recomputed
 * hash on the next real block (durable divergence halt fleet-wide). The
 * fixture-driven unit goldens only lock each side against ITSELF; the live
 * e2e recompute scenario (xchain-e2e-test consensusHashConformance) only runs
 * on a hand-launched regtest stack. This is the CI-time gate.
 */

'use strict';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');

// Sibling resolution + hard-fail policy: same conventions as the reciprocal
// twin guard in rollback-coverage.test.js. Skip when the sibling checkout is
// absent, throw where XCHAIN_REQUIRE_SIBLINGS=1 makes green-by-skip
// impossible (bin/ci-all.sh and the sibling-checkout CI job).
const INDEXER_ROOT = path.resolve(__dirname, '..', '..');
const SYNC_ROOT    = process.env.XCHAIN_SYNC_PATH
    ? path.resolve(process.env.XCHAIN_SYNC_PATH)
    : path.resolve(__dirname, '..', '..', '..', 'xchain-sync');
const SIBLING_REQUIRED = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';
function requireSibling(ctx, absPath){
    if(fs.existsSync(absPath)) return true;
    if(SIBLING_REQUIRED)
        throw new Error('consensus drift guard cannot run: sibling missing at ' + absPath +
            ' (check out xchain-sync or set XCHAIN_SYNC_PATH)');
    ctx.skip();
    return false;
}

// ---- extraction helpers -----------------------------------------------------

// Cut unquoted // comments (tracking ' " ` quote state per line) so the two
// sides compare on code, not on their independently-worded comments.
function stripComments(src){
    return src.split('\n').map(line => {
        let q = null;
        for(let i = 0; i < line.length; i++){
            const ch = line[i];
            if(q){ if(ch === q && line[i-1] !== '\\') q = null; continue; }
            if(ch === "'" || ch === '"' || ch === '`'){ q = ch; continue; }
            if(ch === '/' && line[i+1] === '/') return line.slice(0, i);
        }
        return line;
    }).join('\n');
}

// Comment-stripped, string-concat-joined, whitespace-collapsed form. The `+`
// collapse keeps a template literal split by concatenation (the flag-day
// stateKeyCollate splice) comparable across formatting choices.
function normalize(src){
    return stripComments(src).replace(/\s+\+\s+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Slice a balanced-brace function/method starting at the first match of sigRe.
// Tracks quote state so braces inside string/template literals don't count.
function extractFunction(src, sigRe, from){
    const m = src.match(sigRe);
    assert.ok(m, 'signature not found in ' + from + ': ' + sigRe);
    let depth = 0, q = null;
    for(let j = src.indexOf('{', m.index); j < src.length; j++){
        const ch = src[j];
        if(q){
            if(ch === '\\'){ j++; continue; }
            if(ch === q) q = null;
            continue;
        }
        if(ch === "'" || ch === '"' || ch === '`'){ q = ch; continue; }
        if(ch === '/' && src[j+1] === '/'){ j = src.indexOf('\n', j); continue; }
        if(ch === '{') depth++;
        if(ch === '}'){ depth--; if(depth === 0) return src.slice(m.index, j + 1); }
    }
    assert.fail('unbalanced braces extracting ' + sigRe + ' from ' + from);
}

// Ordered whitespace-collapsed template-literal list inside a function slice.
// A query spliced by concatenation yields one fragment per literal piece; both
// sides splice identically, so the fragment lists still compare pairwise.
function sqlLiterals(fnSrc){
    const out = [];
    const re = /`([^`]*)`/g;
    let m;
    while((m = re.exec(fnSrc)) !== null) out.push(m[1].replace(/\s+/g, ' ').trim());
    return out;
}

function syncFile(rel){ return path.join(SYNC_ROOT, rel); }
function indexerFile(rel){ return path.join(INDEXER_ROOT, rel); }

describe('consensus block-hash conformance twins (static drift-lock, ) @regression', function(){

    function loadPair(ctx, syncRel, indexerRel){
        if(!requireSibling(ctx, syncFile(syncRel))) return null;
        return {
            sync:    fs.readFileSync(syncFile(syncRel), 'utf8'),
            indexer: fs.readFileSync(indexerFile(indexerRel), 'utf8')
        };
    }

    it('BLOCK_HASH_VERSION is identical across indexer db.js and sync BlockHasher.js', function(){
        const pair = loadPair(this, 'src/BlockHasher.js', 'src/db.js');
        if(!pair) return;
        const vSync    = pair.sync.match(/const BLOCK_HASH_VERSION = (\d+)/);
        const vIndexer = pair.indexer.match(/const BLOCK_HASH_VERSION = (\d+)/);
        assert.ok(vSync && vIndexer, 'BLOCK_HASH_VERSION constant missing on one side');
        assert.strictEqual(vIndexer[1], vSync[1],
            'BLOCK_HASH_VERSION drifted between xchain-indexer/src/db.js and ' +
            'xchain-sync/src/BlockHasher.js; a version bump is a consensus break and MUST land on both sides');
    });

    it('every consensus SQL literal matches, in gathering order', function(){
        const pair = loadPair(this, 'src/BlockHasher.js', 'src/db.js');
        if(!pair) return;
        const syncFn    = stripComments(extractFunction(pair.sync,
            /async computeBlockHashes\(block_index, network, coin\)\{/, 'BlockHasher.js'));
        const indexerFn = stripComments(extractFunction(pair.indexer,
            /async getBlockHashes\(block_index\)\{/, 'db.js'));
        const syncSql    = sqlLiterals(syncFn);
        const indexerSql = sqlLiterals(indexerFn);
        assert.ok(indexerSql.length >= 11,
            'expected the 11 consensus gathering queries in db.getBlockHashes, found ' + indexerSql.length +
            ' template literals; if the gathering set changed, mirror it on both sides and update this count');
        assert.strictEqual(indexerSql.length, syncSql.length,
            'consensus query count drifted between db.getBlockHashes (' + indexerSql.length +
            ') and BlockHasher.computeBlockHashes (' + syncSql.length + '); a query added/removed on one side forks the hash');
        for(let i = 0; i < indexerSql.length; i++){
            assert.strictEqual(indexerSql[i], syncSql[i],
                'consensus SQL #' + (i + 1) + ' drifted between db.getBlockHashes and ' +
                'BlockHasher.computeBlockHashes; the SELECT column set / JOINs / ORDER BY are hash preimage inputs ' +
                'and MUST stay byte-identical (modulo whitespace)');
        }
    });

    it('special-address canonicalization covers credits, debits and escrows on both sides', function(){
        const pair = loadPair(this, 'src/BlockHasher.js', 'src/db.js');
        if(!pair) return;
        const loopRe = /for \(const row of ledger\.(credits|debits|escrows)\)\s+row\.address = canonicalizeHashAddress\(row\.address\);/g;
        for(const [name, src] of [['db.js', pair.indexer], ['BlockHasher.js', pair.sync]]){
            const seen = new Set();
            let m;
            loopRe.lastIndex = 0;
            while((m = loopRe.exec(src)) !== null) seen.add(m[1]);
            assert.deepStrictEqual([...seen].sort(), ['credits', 'debits', 'escrows'],
                name + ' must canonicalize BURN/GAS/DONATE/REWARD addresses on all three ledger row sets ' +
                'before hashing; a missing loop leaks the per-chain address encoding into the hash on one side only');
        }
    });

    it('the hash-assembly tail (chaining + hash_version fold) is identical', function(){
        const pair = loadPair(this, 'src/BlockHasher.js', 'src/db.js');
        if(!pair) return;
        const tailRe = /let tables = \[[^]*?tables\.forEach\(table => \{[^]*?\}\);/;
        const tSync    = pair.sync.match(tailRe);
        const tIndexer = pair.indexer.match(tailRe);
        assert.ok(tSync && tIndexer, 'hash-assembly tail (tables.forEach) not found on one side');
        assert.strictEqual(normalize(tIndexer[0]), normalize(tSync[0]),
            'hash-assembly tail drifted between db.getBlockHashes and BlockHasher.computeBlockHashes; ' +
            'the block_index / previous_hash / hash_version fold order is part of the preimage');
    });

    it('utility jsonStringify + getDataHash (shared preimage serializer) are identical', function(){
        const pair = loadPair(this, 'src/utility.js', 'src/utility.js');
        if(!pair) return;
        for(const sig of [/jsonStringify\(obj\)\{/, /getDataHash\(data\)\{/]){
            assert.strictEqual(
                normalize(extractFunction(pair.indexer, sig, 'xchain-indexer/src/utility.js')),
                normalize(extractFunction(pair.sync, sig, 'xchain-sync/src/utility.js')),
                sig + ' drifted between xchain-indexer and xchain-sync utility.js; it serializes every ' +
                'consensus hash preimage and MUST stay identical (bigint coercion included)');
        }
    });

    it('stateCommitment reportOrphanStats is identical (documented twin)', function(){
        const pair = loadPair(this, 'src/stateCommitment.js', 'src/stateCommitment.js');
        if(!pair) return;
        const sig = /async function reportOrphanStats\(query, chain, network, opts\)\{/;
        assert.strictEqual(
            normalize(extractFunction(pair.indexer, sig, 'xchain-indexer/src/stateCommitment.js')),
            normalize(extractFunction(pair.sync, sig, 'xchain-sync/src/stateCommitment.js')),
            'reportOrphanStats drifted between xchain-indexer and xchain-sync stateCommitment.js; ' +
            'the header comment declares it a keep-BYTE-IDENTICAL twin');
    });
});

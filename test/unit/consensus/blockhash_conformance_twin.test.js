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
 * test/unit/consensus/blockhash_conformance_twin.test.js
 *
 * Static drift-lock for the consensus block-hash CONFORMANCE PAIR,
 * reciprocal side: xchain-sync carries the same test, but that copy only runs
 * in sync CI, so an indexer-side edit to the hashing inputs would ship green
 * here and only redden when sync CI next runs with a sibling checkout (the
 * same one-directional hole the whole-file twin guard in
 * rollback_coverage.test.js closes for merkle.js and friends).
 *
 * xchain-sync/src/client/block_hasher.js computeBlockHashes() is a hand-ported twin of
 * xchain-indexer/src/db/actions.js getBlockHashes(): same consensus SELECTs, same
 * special-address canonicalization, same chaining/version fold, hashed through
 * the same getDataHash/jsonStringify pair. The two live inside DIFFERENT host
 * structures (a db/actions.js mixin method vs a sync class), so whole-file byte-identity
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
 *   6. reportOrphanStats (documented byte-identical twin; compared RAW, header
 *      comment included, unlike the normalized checks). The indexer keeps it in
 *      src/state_commitment/persistent_smt.js, the follower in its whole-file
 *      src/stateCommitment.js
 *   7. the state_key collation flag-day gate (the STATE_KEY_COLLATION_KEY
 *      value, the activeAt call shape, the ' COLLATE utf8_bin' splice value and
 *      where it is spliced), which item 2 cannot see; checked in
 *      blockhash_conformance_twin.test/01_state_key_collation_gate.test.js
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

// Sibling policy, source loading and extraction live in one helper so every
// twin suite under blockhash_conformance_twin.test/ reads the sources the same way.
const { stripComments, normalize, extractFunction, sqlLiterals, syncFile, loadPair } =
    require('./blockhash_conformance_twin.test/helpers/twin_sources.js');

const indexerGatheringSource = require('./blockhash_conformance_twin.test/helpers/indexer_gathering.js').make({ assert, stripComments, extractFunction, sqlLiterals });

// Assert the three canonicalization loops run INSIDE fnSrc, after the escrows
// gather (afterText) and before hashing (beforeText), with nothing reassigning or
// reordering a ledger row set between the last loop and the hash.
function assertCanonicalizedBeforeHash(fnSrc, from, afterText, beforeText){
    const body  = stripComments(fnSrc);
    const start = body.indexOf(afterText);
    const end   = body.indexOf(beforeText, start);
    assert.ok(start !== -1 && end > start, from + ' no longer has `' + afterText + '` followed by `' + beforeText + '`');
    const loopRe = /for \(const row of ledger\.(credits|debits|escrows)\)\s+row\.address = canonicalizeHashAddress\(row\.address\);/g;
    const seen = new Set();
    let m, lastEnd = -1;
    while((m = loopRe.exec(body)) !== null){
        assert.ok(m.index > start && m.index < end, 'the ' + m[1] + ' canonicalization loop in ' + from +
            ' runs outside the window between the escrows gather and the hash');
        seen.add(m[1]);
        lastEnd = m.index + m[0].length;
    }
    assert.deepStrictEqual([...seen].sort(), ['credits', 'debits', 'escrows'],
        from + ' must canonicalize BURN/GAS/DONATE/REWARD addresses on all three ledger row sets ' +
        'before hashing; a missing loop leaks the per-chain address encoding into the hash on one side only');
    assert.doesNotMatch(body.slice(lastEnd, end), /ledger\.(credits|debits|escrows)\s*(=(?!=)|\.(sort|reverse|splice|map|filter)\()/,
        from + ' reassigns or reorders a canonicalized ledger row set before hashing it');
}

describe('consensus block-hash conformance twins (static drift-lock) @regression', function(){

    it('BLOCK_HASH_VERSION is identical across indexer db.js and sync BlockHasher.js', function(){
        const pair = loadPair(this, 'src/client/block_hasher.js', 'src/db');
        if(!pair) return;
        const vSync    = pair.sync.match(/const BLOCK_HASH_VERSION = (\d+)/);
        const vIndexer = pair.indexer.match(/const BLOCK_HASH_VERSION = (\d+)/);
        assert.ok(vSync && vIndexer, 'BLOCK_HASH_VERSION constant missing on one side');
        assert.strictEqual(vIndexer[1], vSync[1],
            'BLOCK_HASH_VERSION drifted between xchain-indexer/src/db/shared.js and ' +
            'xchain-sync/src/client/block_hasher.js; a version bump is a consensus break and MUST land on both sides');
    });

    it('every consensus SQL literal matches, in gathering order', function(){
        const pair = loadPair(this, 'src/client/block_hasher.js', 'src/db');
        if(!pair) return;
        const syncFn    = stripComments(extractFunction(pair.sync,
            /async computeBlockHashes\(block_index, network, coin\)\{/, 'block_hasher.js'));
        const indexerFn = indexerGatheringSource(pair.indexer);
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
        const pair = loadPair(this, 'src/client/block_hasher.js', 'src/db/actions.js');
        if(!pair) return;
        // Scoped to the hashing functions, so a loop moved into an uncalled helper fails here.
        assertCanonicalizedBeforeHash(
            extractFunction(pair.indexer, /async getBlockHashLedgerRows\(block_index\)\{/, 'db/actions.js'),
            'db.getBlockHashLedgerRows', 'this.getBlockHashEscrowRows(', 'return ledger;');
        assertCanonicalizedBeforeHash(
            extractFunction(pair.sync, /async computeBlockHashes\(block_index, network, coin\)\{/, 'block_hasher.js'),
            'BlockHasher.computeBlockHashes', 'ledger.escrows = await this.db.doQueryStrict(', 'let tables = [');
        // The indexer canonicalizes in a helper, so its hash path must actually take the helper's rows.
        const getHashes = stripComments(extractFunction(pair.indexer, /async getBlockHashes\(block_index\)\{/, 'db/actions.js')).replace(/\s+/g, ' ');
        assert.strictEqual(getHashes.split('const ledger = await this.getBlockHashLedgerRows(block_index);').length - 1, 1,
            'db.getBlockHashes must take its ledger rows from getBlockHashLedgerRows exactly once');
        assert.doesNotMatch(getHashes, /ledger\.(credits|debits|escrows)\s*(=(?!=)|\.(sort|reverse|splice|map|filter)\()/,
            'db.getBlockHashes reassigns or reorders a canonicalized ledger row set before hashing it');
    });
});

describe('consensus block-hash conformance twins (static drift-lock) @regression', function(){

    it('the hash-assembly tail (chaining + hash_version fold) is identical', function(){
        const pair = loadPair(this, 'src/client/block_hasher.js', 'src/db');
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
        const pair = loadPair(this, 'src/util/index.js', 'src/utility.js');
        if(!pair) return;
        for(const sig of [/jsonStringify\(obj\)\{/, /getDataHash\(data\)\{/]){
            assert.strictEqual(
                normalize(extractFunction(pair.indexer, sig, 'xchain-indexer/src/utility.js')),
                normalize(extractFunction(pair.sync, sig, 'xchain-sync/src/util/index.js')),
                sig + ' drifted between xchain-indexer and xchain-sync utility.js; it serializes every ' +
                'consensus hash preimage and MUST stay identical (bigint coercion included)');
        }
    });

    it('stateCommitment reportOrphanStats block is BYTE-identical (documented twin, comments included)', function(){
        // The indexer half is the persistent_smt part: the entry re-exports the
        // function but no longer carries its text, and a read of the entry would
        // fail on the marker rather than compare nothing.
        // The follower moved to src/state_commitment/index.js; a sibling from before that move
        // still carries the flat file, so the pair reads whichever spelling it has.
        const followerRel = fs.existsSync(syncFile('src/state_commitment/index.js')) ? 'src/state_commitment/index.js' : 'src/stateCommitment.js';
        const pair = loadPair(this, followerRel, 'src/state_commitment/persistent_smt.js');
        if(!pair) return;
        // The twin contract covers the whole block: the "---- Orphan-node
        // observability" header comment THROUGH the end of reportOrphanStats.
        // Raw byte comparison, no comment-stripping or whitespace-normalizing:
        // the header comment itself carries the twin contract.
        const sig = /async function reportOrphanStats\(query, chain, network, opts\)\{/;
        function extractTwinBlock(src, from){
            const marker = '// ---- Orphan-node observability';
            const i = src.indexOf(marker);
            assert.ok(i !== -1, 'orphan-observability marker not found in ' + from);
            const tail = src.slice(i);
            const fn = extractFunction(tail, sig, from);
            return tail.slice(0, tail.indexOf(fn) + fn.length);
        }
        assert.strictEqual(
            extractTwinBlock(pair.indexer, 'xchain-indexer/src/state_commitment/persistent_smt.js'),
            extractTwinBlock(pair.sync, 'xchain-sync/src/stateCommitment.js'),
            'reportOrphanStats block drifted between xchain-indexer persistent_smt.js and xchain-sync stateCommitment.js; ' +
            'the header comment declares it a keep-BYTE-IDENTICAL twin (comments included)');
    });
});

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
 **********************************************************************/

// test/unit/consensus/blockhash_conformance_twin.test/helpers/twin_sources.js
//
// Source loading and extraction shared by the block-hash conformance twin suites,
// so every suite reads the sources by one definition of "the function body".

'use strict';

const assert  = require('assert');
const fs      = require('fs');
const path    = require('path');
const { concatSrcTreeFiles } = require('../../../../helpers/src_tree_files');
const { siblingCheckout } = require('../../../../helpers/sibling_checkout.js');
const { makeLoadPair } = require('./pair_loader.js');

// Sibling resolution + hard-fail policy: same conventions as the reciprocal
// twin guard in rollback_coverage.test.js. Skip when the sibling checkout is
// absent, throw where XCHAIN_REQUIRE_SIBLINGS=1 makes green-by-skip
// impossible (bin/ci-all.sh and the sibling-checkout CI job).
const INDEXER_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const SYNC_ROOT    = process.env.XCHAIN_SYNC_PATH
    ? path.resolve(process.env.XCHAIN_SYNC_PATH)
    : path.resolve(INDEXER_ROOT, '..', 'xchain-sync');
const SIBLING_REQUIRED = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';
// Presence is the shared sibling verdict, so a lane symlink into a live main
// checkout is refused exactly like an absent sync tree, and the error names why.
function requireSibling(ctx, absPath){
    const verdict = siblingCheckout(__dirname, absPath);
    if(verdict.usable) return true;
    if(SIBLING_REQUIRED)
        throw new Error('consensus drift guard cannot run: ' + verdict.reason +
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

// The indexer half of a twin may be a directory (the Database class is one file per
// table family), in which case the scan reads every file in a fixed order.
function indexerSource(rel){
    const full = indexerFile(rel);
    if(!fs.statSync(full).isDirectory()) return fs.readFileSync(full, 'utf8');
    return concatSrcTreeFiles(full);
}

const loadPair = makeLoadPair({ fs, requireSibling, syncFile, indexerSource });

module.exports = { INDEXER_ROOT, SYNC_ROOT, requireSibling, stripComments, normalize, extractFunction,
    sqlLiterals, syncFile, indexerFile, indexerSource, loadPair };

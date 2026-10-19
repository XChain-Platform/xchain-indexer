#!/usr/bin/env node
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
 *********************************************************************/

'use strict';

// Keeps the xchain-sync copy of the utf8mb4 inventory equal to the canonical file in this
// repo. xchain-sync has no dependency on this package, so it carries a copy; the copy is the
// canonical text with its provenance paragraph swapped, and nothing else.
//
//   node bin/sync-utf8mb4-columns.js --check    exit 1 when the copy is missing or stale
//   node bin/sync-utf8mb4-columns.js --write    rewrite the copy from the canonical file
//
// The sync checkout is ../xchain-sync unless XCHAIN_SYNC_SOURCE names another one.
// The canonical file is read as text, never required, so this tool adds no runtime edge.

const fs   = require('fs');
const path = require('path');

const CANONICAL_REL = path.join('src', 'chain', 'utf8mb4_columns.js');
const COPY_REL      = path.join('src', 'schema', 'utf8mb4_columns.js');

// The provenance paragraph runs from this line to the next bare ` *` line.
const PARAGRAPH_START = ' * CANONICAL INVENTORY';

const COPY_PARAGRAPH = [
    ' * SYNCED COPY of the canonical inventory in xchain-indexer/src/chain/utf8mb4_columns.js.',
    ' * Never edit this file: change the canonical file, then run',
    ' * `node bin/sync-utf8mb4-columns.js --write` in xchain-indexer. xchain-sync has no',
    ' * dependency on that package by design, so it carries this copy.',
];

function splitParagraph(text){
    const lines = text.split('\n');
    const start = lines.findIndex(l => l.startsWith(PARAGRAPH_START));
    if(start < 0) return null;
    let end = start + 1;
    while(end < lines.length && lines[end] !== ' *') end++;
    if(end >= lines.length) return null;
    return { lines, start, end };
}

// The text the xchain-sync copy must hold for a given canonical text. Throws when the
// canonical text has lost its provenance paragraph, so a broken header cannot sync silently.
function renderCopy(canonicalText){
    const parts = splitParagraph(canonicalText);
    if(!parts) throw new Error('canonical inventory has no "' + PARAGRAPH_START.trim() + '" paragraph');
    const { lines, start, end } = parts;
    return lines.slice(0, start).concat(COPY_PARAGRAPH, lines.slice(end)).join('\n');
}

function paths(indexerRoot, syncRoot){
    return {
        canonical: path.join(indexerRoot, CANONICAL_REL),
        copy:      path.join(syncRoot, COPY_REL),
    };
}

// { ok, reason } for whether the copy matches what renderCopy produces.
function checkCopy(indexerRoot, syncRoot){
    const p = paths(indexerRoot, syncRoot);
    if(!fs.existsSync(p.copy)) return { ok: false, reason: 'missing ' + p.copy };
    const want = renderCopy(fs.readFileSync(p.canonical, 'utf8'));
    const have = fs.readFileSync(p.copy, 'utf8');
    return have === want ? { ok: true, reason: '' } : { ok: false, reason: 'stale ' + p.copy };
}

function writeCopy(indexerRoot, syncRoot){
    const p = paths(indexerRoot, syncRoot);
    fs.mkdirSync(path.dirname(p.copy), { recursive: true });
    fs.writeFileSync(p.copy, renderCopy(fs.readFileSync(p.canonical, 'utf8')));
    return p.copy;
}

function main(argv, env){
    const mode = argv[2];
    if(mode !== '--check' && mode !== '--write'){
        console.error('usage: sync-utf8mb4-columns.js --check | --write');
        return 64;
    }
    const indexerRoot = path.resolve(__dirname, '..');
    const syncRoot    = env.XCHAIN_SYNC_SOURCE || path.resolve(indexerRoot, '..', 'xchain-sync');
    if(!fs.existsSync(syncRoot)){
        console.error('xchain-sync checkout not found at ' + syncRoot + ' (set XCHAIN_SYNC_SOURCE)');
        return 2;
    }
    if(mode === '--write'){
        console.log('wrote ' + writeCopy(indexerRoot, syncRoot));
        return 0;
    }
    const res = checkCopy(indexerRoot, syncRoot);
    if(!res.ok) console.error(res.reason + '; run bin/sync-utf8mb4-columns.js --write');
    return res.ok ? 0 : 1;
}

module.exports = { renderCopy, checkCopy, writeCopy, splitParagraph, COPY_PARAGRAPH, PARAGRAPH_START };

if(require.main === module) process.exit(main(process.argv, process.env));

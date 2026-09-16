/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Indexer - Genesis Mixin: Manifest Rows
 *
 * Loading and ordering the name-reservation manifest (tick,owner CSV) that
 * ../genesis.js's inject() replays. Installed onto Genesis.prototype by
 * ../genesis.js, so call sites stay this.loadRows() / this.ancestorSet().
 *
 ********************************************************************/

const fs = require('fs');

const { getLogger } = require('../../observability/index.js');

module.exports = {

    // Read the manifest CSV (tick,owner_address). Owner addresses never contain a comma,
    // so the LAST comma separates tick from owner (ticks may be RFC4180-quoted and could
    // in principle contain commas). Dedupe by tick (last row wins) and skip ticks the
    // ISSUE handler would reject anyway. Finally assert parent-before-child ordering so a
    // malformed manifest fails before any DB write rather than mid-injection.
    loadRows(file){
        let lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        let rows  = [];
        let index = new Map(); // tick -> position in rows (dedupe)
        for(let line of lines){
            if(line === '' || line === 'tick,owner_address')
                continue;
            let comma = line.lastIndexOf(',');
            if(comma < 0)
                continue;
            let tick  = line.slice(0, comma).trim();
            let owner = line.slice(comma + 1).trim();
            // Unwrap an RFC4180-quoted tick ("..."" -> ").
            if(tick.length >= 2 && tick[0] === '"' && tick[tick.length - 1] === '"')
                tick = tick.slice(1, -1).replace(/""/g, '"');
            if(tick === '' || owner === '')
                continue;
            // Protocol sanity (the handler rejects these too; skip + log rather than abort).
            if(tick.indexOf('|') !== -1 || tick.indexOf(';') !== -1){
                getLogger().warn('GENESIS skip (separator char in tick): ' + tick);
                continue;
            }
            if(tick.length > this.config['MAX_TICK_LENGTH']){
                getLogger().warn('GENESIS skip (tick exceeds MAX_TICK_LENGTH): ' + tick);
                continue;
            }
            if(index.has(tick))
                rows[index.get(tick)].owner = owner;  // last row wins
            else {
                index.set(tick, rows.length);
                rows.push({ tick: tick, owner: owner });
            }
        }
        // Parent-before-child invariant: a child's immediate parent must already appear.
        let present = new Set();
        for(let r of rows){
            let parts = r.tick.split('.');
            if(parts.length > 1){
                let parent = parts.slice(0, -1).join('.');
                if(!present.has(parent))
                    throw new Error('GENESIS FATAL: child "' + r.tick + '" precedes its parent "' + parent + '" in the manifest');
            }
            present.add(r.tick);
        }
        return rows;
    },

    // Build the set of ancestor ticks: a tick is an ancestor if some other loaded tick
    // names it as a parent prefix (e.g. "A" and "A.B" make "A" an ancestor). Each tick's
    // own strict prefixes are added only when they are themselves present in the manifest,
    // so the set contains real reserved names that gate at least one descendant's creation.
    // The parent-before-child invariant is already asserted in loadRows.
    ancestorSet(rows){
        let present   = new Set(rows.map(r => r.tick));
        let ancestors = new Set();
        for(let r of rows){
            let parts = r.tick.split('.');
            for(let i = 1; i < parts.length; i++){
                let prefix = parts.slice(0, i).join('.');
                if(present.has(prefix))
                    ancestors.add(prefix);
            }
        }
        return ancestors;
    },

};

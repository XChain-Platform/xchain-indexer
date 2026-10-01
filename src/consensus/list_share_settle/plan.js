'use strict';

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

const COINS = new Set(['BTC', 'LTC', 'DOGE']);

function toInt(value, label){
    if(typeof value === 'bigint')
        return value;
    if(typeof value === 'number' && Number.isSafeInteger(value))
        return BigInt(value);
    if(typeof value === 'string' && /^[0-9]+$/.test(value))
        return BigInt(value);
    throw new TypeError(`${label} must be an integer`);
}

function heightOf(row, column){
    const raw = row[column];
    if(raw === null || raw === undefined || raw === '')
        return null;
    return toInt(raw, column);
}

function compareText(a, b){
    if(a < b) return -1;
    if(a > b) return 1;
    return 0;
}

function compareBig(a, b){
    if(a < b) return -1;
    if(a > b) return 1;
    return 0;
}

// Walks one list from its next unapplied seq. A later due seq makes a missing
// or heightless next seq a halt; with nothing later due the list just waits.
function walkList(entry, column, blockIndex){
    const applied = toInt(entry.applied, 'applied');
    const bySeq = new Map();
    let lastDue = null;

    for(const row of entry.rows){
        const seq = toInt(row.seq, 'seq');
        if(seq <= applied || bySeq.has(seq))
            continue;
        const height = heightOf(row, column);
        bySeq.set(seq, { row, height });
        if(height !== null && height <= blockIndex && (lastDue === null || seq > lastDue))
            lastDue = seq;
    }

    const due = [];
    for(let seq = applied + 1n; ; seq++){
        const laterDue = lastDue !== null && lastDue > seq;
        const found = bySeq.get(seq);

        if(!found){
            if(laterDue)
                return { halt: { reason: 'SEQ_GAP', seq: Number(seq) }, due };
            return { due };
        }
        if(found.height === null){
            if(laterDue)
                return { halt: { reason: 'NO_HEIGHT', seq: Number(seq) }, due };
            return { due };
        }
        if(found.height > blockIndex)
            return { due };

        due.push(found.row);
    }
}

function planDueVersions({ lists, coin, blockIndex, cap }){
    if(!Array.isArray(lists))
        throw new TypeError('lists must be an array');
    if(!COINS.has(coin))
        throw new TypeError('coin must be BTC, LTC or DOGE');
    if(!Number.isInteger(blockIndex) || blockIndex < 0)
        throw new TypeError('blockIndex must be a non-negative integer');
    if(!Number.isInteger(cap) || cap < 1)
        throw new TypeError('cap must be a positive integer');

    const column = 'admit_block_' + coin.toLowerCase();
    const height = BigInt(blockIndex);

    const ordered = lists.map(entry => ({
        entry,
        index: toInt(entry.home_list_index, 'home_list_index')
    })).sort((a, b) => compareText(a.entry.home_chain, b.entry.home_chain) || compareBig(a.index, b.index));

    const due = [];
    for(const { entry } of ordered){
        const walked = walkList(entry, column, height);
        if(walked.halt){
            return {
                halt: {
                    reason: walked.halt.reason,
                    home_chain: entry.home_chain,
                    home_list_index: entry.home_list_index,
                    seq: walked.halt.seq
                }
            };
        }
        due.push(...walked.due);
    }

    return { due: due.slice(0, cap) };
}

module.exports = { planDueVersions };

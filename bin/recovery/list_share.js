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
 ********************************************************************/

'use strict';

const bridgeSettle = require('../../src/consensus/bridge_settle.js');
const listCanonical = require('../../src/consensus/list_share_settle/canonical.js');
const swq = require('../../src/consensus/stake_weighted_quorum.js');

const HEX64 = /^[0-9a-f]{64}$/;
const HOME_CHAINS = new Set(['BTC', 'LTC', 'DOGE']);
const LIST_TYPES = new Set([1, 2]);

function fail(id, reason){
    throw new Error('list snapshot ' + String(id || '').substring(0, 16) + '... ' + reason);
}

function integer(value){
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function plainObject(value){
    if(!value || typeof value !== 'object' || Array.isArray(value)) return false;
    let prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function validateListSnapshot(row, network){
    let id = row && row.snapshot_id;
    if(!plainObject(row)) fail(id, 'has malformed shape');
    if(!HEX64.test(String(row.snapshot_id || ''))) fail(id, 'has malformed snapshot_id');
    if(!HEX64.test(String(row.members_hash || ''))) fail(id, 'has malformed members_hash');
    for(let key of ['id', 'snapshot_block', 'home_list_index', 'list_type', 'seq',
                    'origin_block', 'finalizing_view']){
        if(!integer(row[key])) fail(id, 'has malformed ' + key);
    }
    if(row.network !== network) fail(id, 'network does not match archive head');
    if(row.status !== 'finalized') fail(id, 'has malformed status');
    if(!HOME_CHAINS.has(row.home_chain)) fail(id, 'has malformed home_chain');
    if(!LIST_TYPES.has(row.list_type)) fail(id, 'has malformed list_type');
    if(row.seq < 1) fail(id, 'has malformed seq');
    if(row.kind !== (row.seq === 1 ? 'full' : 'delta')) fail(id, 'has malformed kind');
    for(let key of ['admit_block_btc', 'admit_block_ltc', 'admit_block_doge']){
        if(row[key] !== null && row[key] !== undefined && !integer(row[key]))
            fail(id, 'has malformed ' + key);
    }
    if(typeof row.validator_signatures !== 'string')
        fail(id, 'has malformed validator_signatures');
    if(typeof row.added !== 'string' || typeof row.removed !== 'string')
        fail(id, 'has malformed membership lists');

    let added = bridgeSettle.parseMembership(row.added);
    let removed = bridgeSettle.parseMembership(row.removed);
    if(!Array.isArray(added) || !Array.isArray(removed) ||
       !bridgeSettle.verifyMembershipOrder(added) ||
       !bridgeSettle.verifyMembershipOrder(removed))
        fail(id, 'has malformed or unordered membership lists');
    if(row.seq === 1 && removed.length !== 0)
        fail(id, 'full snapshot has removed members');

    let expected = listCanonical.deriveListSnapshotId(
        row.network, row.home_chain, row.home_list_index, row.seq, row.snapshot_block);
    if(row.snapshot_id !== expected) fail(id, 'snapshot_id does not match list sequence');
}

function verifyArchive(archive, ctx){
    let rows = archive.list_snapshots;
    if(rows === undefined || rows === null) return;
    if(!Array.isArray(rows)) throw new Error('malformed list archive rows');
    if(rows.length > 0 && typeof ctx.listShareCanonical !== 'function')
        throw new Error('listShareCanonical must be a function');
    for(let row of rows){
        validateListSnapshot(row, ctx.network);
        let set = ctx.setFor('cross_chain', row.snapshot_block);
        let sigs = ctx.parseSigs(row.validator_signatures);
        let weighted = swq.isStakeWeightedQuorumActive(row.snapshot_block, row.network);
        if(!ctx.quorumVerified(ctx.listShareCanonical(row), sigs, set, weighted))
            fail(row.snapshot_id, 'fails quorum against the archived cross_chain set');
    }
}

async function writeListSnapshot(db, row){
    let byId = await db.doQuery(
        'SELECT snapshot_id FROM list_snapshots WHERE snapshot_id = ? LIMIT 1', [row.snapshot_id]);
    if(byId && byId.length > 0) return;
    let bySeq = await db.doQuery(
        `SELECT snapshot_id FROM list_snapshots
         WHERE network = ? AND home_chain = ? AND home_list_index = ? AND seq = ? LIMIT 1`,
        [row.network, row.home_chain, Number(row.home_list_index), Number(row.seq)]);
    if(bySeq && bySeq.length > 0 && bySeq[0].snapshot_id !== row.snapshot_id)
        fail(row.snapshot_id, 'collides with an existing list sequence');
    await db.doQuery(
        `INSERT IGNORE INTO list_snapshots
            (id, snapshot_id, snapshot_block, network, home_chain, home_list_index,
             list_type, seq, kind, origin_block, members_hash, added, removed,
             admit_block_btc, admit_block_ltc, admit_block_doge, finalizing_view,
             validator_signatures, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [Number(row.id), row.snapshot_id, Number(row.snapshot_block), row.network,
         row.home_chain, Number(row.home_list_index), Number(row.list_type), Number(row.seq),
         row.kind, Number(row.origin_block), row.members_hash, row.added, row.removed,
         row.admit_block_btc == null ? null : Number(row.admit_block_btc),
         row.admit_block_ltc == null ? null : Number(row.admit_block_ltc),
         row.admit_block_doge == null ? null : Number(row.admit_block_doge),
         Number(row.finalizing_view) || 0, row.validator_signatures, row.status]);
}

async function writeArchive(db, archive, report){
    if(report.lists === undefined) report.lists = 0;
    for(let row of (archive.list_snapshots || [])){
        await writeListSnapshot(db, row);
        report.lists++;
    }
}

module.exports = { validateListSnapshot, verifyArchive, writeListSnapshot, writeArchive };

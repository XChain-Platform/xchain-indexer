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
const swq = require('../../src/consensus/stake_weighted_quorum.js');

const HEX64 = /^[0-9a-f]{64}$/;
const STATUSES = new Set(['finalized', 'retracted']);

function fail(kind, id, reason){
    throw new Error(kind + ' ' + String(id || '').substring(0, 16) + '... ' + reason);
}

function integer(value){
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function text(value){
    return typeof value === 'string' && value.length > 0;
}

function validateShared(kind, row, idKey, network){
    let id = row && row[idKey];
    if(!row || typeof row !== 'object' || Array.isArray(row)) fail(kind, id, 'has malformed shape');
    if(!HEX64.test(String(id || ''))) fail(kind, id, 'has malformed ' + idKey);
    if(!integer(row.id) || !integer(row.snapshot_block) || !integer(row.effective_time) || !integer(row.finalizing_view))
        fail(kind, id, 'has malformed integer fields');
    if(row.network !== network) fail(kind, id, 'network does not match archive head');
    if(!STATUSES.has(row.status)) fail(kind, id, 'has malformed status');
    for(let key of ['admit_block_btc', 'admit_block_ltc', 'admit_block_doge'])
        if(row[key] !== null && row[key] !== undefined && !integer(row[key]))
            fail(kind, id, 'has malformed ' + key);
    if(typeof row.validator_signatures !== 'string')
        fail(kind, id, 'has malformed validator_signatures');
}

function validateTransfer(row, network){
    validateShared('bridge transfer', row, 'transfer_id', network);
    for(let key of ['src_chain', 'src_address', 'dest_chain', 'dest_address', 'tick', 'amount'])
        if(!text(row[key])) fail('bridge transfer', row.transfer_id, 'has malformed ' + key);
    if(!integer(row.src_action_index) || !integer(row.decimals) || Number(row.decimals) > 255)
        fail('bridge transfer', row.transfer_id, 'has malformed numeric fields');
}

function validatePolicy(row, network){
    validateShared('policy snapshot', row, 'snapshot_id', network);
    for(let key of ['origin_chain', 'tick', 'policy_hash'])
        if(!text(row[key])) fail('policy snapshot', row.snapshot_id, 'has malformed ' + key);
    if(!HEX64.test(row.policy_hash) || !integer(row.policy_seq) || !integer(row.origin_block))
        fail('policy snapshot', row.snapshot_id, 'has malformed policy fields');
    if(row.allow_list !== null && typeof row.allow_list !== 'string')
        fail('policy snapshot', row.snapshot_id, 'has malformed allow_list');
    if(row.block_list !== null && typeof row.block_list !== 'string')
        fail('policy snapshot', row.snapshot_id, 'has malformed block_list');
    if(!(row.sleeping === 0 || row.sleeping === 1))
        fail('policy snapshot', row.snapshot_id, 'has malformed sleeping');

    let allow = bridgeSettle.parseMembership(row.allow_list);
    let block = bridgeSettle.parseMembership(row.block_list);
    if(allow === false || block === false || !bridgeSettle.verifyMembershipOrder(allow) ||
       !bridgeSettle.verifyMembershipOrder(block))
        fail('policy snapshot', row.snapshot_id, 'has malformed or unordered membership list');
    if(bridgeSettle.policyHash(allow, block, !!row.sleeping) !== row.policy_hash)
        fail('policy snapshot', row.snapshot_id, 'policy_hash does not match membership lists');
}

function verifyRow(kind, row, canonical, ctx){
    let set = ctx.setFor('cross_chain', row.snapshot_block);
    let sigs = ctx.parseSigs(row.validator_signatures);
    let weighted = swq.isStakeWeightedQuorumActive(row.snapshot_block, row.network);
    if(!ctx.quorumVerified(canonical, sigs, set, weighted))
        fail(kind, row.transfer_id || row.snapshot_id, 'fails quorum against the archived cross_chain set');
}

function verifyArchive(archive, ctx){
    let bridges = archive.bridge_transfers || [];
    let policies = archive.policy_snapshots || [];
    if(!Array.isArray(bridges) || !Array.isArray(policies))
        throw new Error('malformed bridge or policy archive rows');
    for(let row of bridges){
        validateTransfer(row, ctx.network);
        verifyRow('bridge transfer', row, bridgeSettle.transferCanonical(row), ctx);
    }
    for(let row of policies){
        validatePolicy(row, ctx.network);
        verifyRow('policy snapshot', row, bridgeSettle.policyCanonical(row), ctx);
    }
}

async function writeBridge(db, row){
    let existing = await db.doQuery(
        'SELECT transfer_id FROM bridge_transfers WHERE transfer_id = ? LIMIT 1', [row.transfer_id]);
    if(existing && existing.length > 0){
        await db.doQuery('UPDATE bridge_transfers SET status = ? WHERE transfer_id = ?',
                         [row.status, row.transfer_id]);
        return;
    }
    await db.doQuery(
        `INSERT INTO bridge_transfers
            (id, transfer_id, snapshot_block, network, src_chain, src_action_index,
             src_address, dest_chain, dest_address, tick, decimals, amount, effective_time,
             admit_block_btc, admit_block_ltc, admit_block_doge, finalizing_view,
             validator_signatures, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [Number(row.id), row.transfer_id, Number(row.snapshot_block), row.network,
         row.src_chain, Number(row.src_action_index), row.src_address, row.dest_chain,
         row.dest_address, row.tick, Number(row.decimals), row.amount, Number(row.effective_time),
         row.admit_block_btc == null ? null : Number(row.admit_block_btc),
         row.admit_block_ltc == null ? null : Number(row.admit_block_ltc),
         row.admit_block_doge == null ? null : Number(row.admit_block_doge),
         Number(row.finalizing_view) || 0, row.validator_signatures, row.status]);
}

async function writePolicy(db, row){
    let byId = await db.doQuery(
        'SELECT snapshot_id FROM policy_snapshots WHERE snapshot_id = ? LIMIT 1', [row.snapshot_id]);
    if(byId && byId.length > 0) return;
    let bySeq = await db.doQuery(
        `SELECT snapshot_id FROM policy_snapshots
         WHERE network = ? AND origin_chain = ? AND tick = ? AND policy_seq = ? LIMIT 1`,
        [row.network, row.origin_chain, row.tick, Number(row.policy_seq)]);
    if(bySeq && bySeq.length > 0 && bySeq[0].snapshot_id !== row.snapshot_id)
        fail('policy snapshot', row.snapshot_id, 'collides with an existing policy sequence');
    await db.doQuery(
        `INSERT IGNORE INTO policy_snapshots
            (id, snapshot_id, snapshot_block, network, origin_chain, tick, policy_seq,
             origin_block, policy_hash, allow_list, block_list, sleeping, effective_time,
             admit_block_btc, admit_block_ltc, admit_block_doge, finalizing_view,
             validator_signatures, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [Number(row.id), row.snapshot_id, Number(row.snapshot_block), row.network,
         row.origin_chain, row.tick, Number(row.policy_seq), Number(row.origin_block),
         row.policy_hash, row.allow_list, row.block_list, Number(row.sleeping),
         Number(row.effective_time),
         row.admit_block_btc == null ? null : Number(row.admit_block_btc),
         row.admit_block_ltc == null ? null : Number(row.admit_block_ltc),
         row.admit_block_doge == null ? null : Number(row.admit_block_doge),
         Number(row.finalizing_view) || 0, row.validator_signatures, row.status]);
}

async function writeArchive(db, archive, report){
    for(let row of (archive.bridge_transfers || [])){
        await writeBridge(db, row);
        report.bridges++;
    }
    for(let row of (archive.policy_snapshots || [])){
        await writePolicy(db, row);
        report.policies++;
    }
}

module.exports = { verifyArchive, writeArchive };

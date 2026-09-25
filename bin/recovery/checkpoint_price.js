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

const ed25519 = require('../../src/consensus/ed25519.js');
const swq = require('../../src/consensus/stake_weighted_quorum.js');

const HEX64 = /^[0-9a-f]{64}$/;
const PRICE_STATUSES = new Set(['finalized', 'skipped', 'disputed']);
const CHECKPOINT_COLUMNS = ['chain', 'network', 'block_index', 'block_hash', 'ledger_hash',
    'actions_hash', 'contract_hash', 'checkpoint_seq', 'snapshot_block', 'state_root',
    'state_root_version', 'block_merkle_root', 'block_merkle_version', 'validator_signatures'];

function fail(kind, key, reason){
    throw new Error(kind + ' ' + String(key || '').substring(0, 32) + '... ' + reason);
}

function integer(value){
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function nullableInteger(value){
    return value === null || integer(value);
}

function text(value){
    return typeof value === 'string' && value.length > 0;
}

function checkpointKey(row){
    return row && row.chain + '/' + row.network + '/' + row.checkpoint_seq;
}

function priceKey(row){
    return row && row.round_number + '/' + row.coin_pair;
}

function validateCheckpoint(row, network){
    let key = checkpointKey(row);
    if(!row || typeof row !== 'object' || Array.isArray(row)) fail('checkpoint', key, 'has malformed shape');
    if(!text(row.chain) || row.network !== network) fail('checkpoint', key, 'has malformed chain or network');
    if(!integer(row.id) || !integer(row.block_index) || !integer(row.checkpoint_seq) || !integer(row.snapshot_block))
        fail('checkpoint', key, 'has malformed integer fields');
    for(let name of ['block_hash', 'ledger_hash', 'actions_hash', 'contract_hash'])
        if(!HEX64.test(String(row[name] || ''))) fail('checkpoint', key, 'has malformed ' + name);
    let rootless = row.state_root === null && row.state_root_version === null &&
        row.block_merkle_root === null && row.block_merkle_version === null;
    let rooted = HEX64.test(String(row.state_root || '')) && integer(row.state_root_version) &&
        HEX64.test(String(row.block_merkle_root || '')) && integer(row.block_merkle_version);
    if(!rootless && !rooted) fail('checkpoint', key, 'has malformed commitment roots');
    if(typeof row.validator_signatures !== 'string') fail('checkpoint', key, 'has malformed validator_signatures');
}

function parsedProof(row){
    if(typeof row.consensus_proof !== 'string') fail('price', priceKey(row), 'has malformed consensus_proof');
    try { return JSON.parse(row.consensus_proof); }
    catch(e) { fail('price', priceKey(row), 'has malformed consensus_proof'); }
}

function validBatchProof(proof){
    if(!proof || typeof proof !== 'object' || Array.isArray(proof) || !proof.batch || !Array.isArray(proof.sigs)) return false;
    let batch = proof.batch;
    return integer(batch.first_round) && integer(batch.last_round) && integer(batch.btc_block_height) &&
        batch.last_round >= batch.first_round && proof.sigs.every(validSignature);
}

function validSignature(sig){
    return !!sig && typeof sig === 'object' && HEX64.test(String(sig.pubkey || '')) &&
        /^[0-9a-f]{128}$/.test(String(sig.sig || ''));
}

function validatePrice(row){
    let key = priceKey(row);
    if(!row || typeof row !== 'object' || Array.isArray(row)) fail('price', key, 'has malformed shape');
    for(let name of ['id', 'round_number', 'reference_block', 'block_timestamp', 'validator_count',
                     'consensus_round', 'batch_block_time'])
        if(!integer(row[name])) fail('price', key, 'has malformed ' + name);
    for(let name of ['source_action_index', 'admit_block_btc', 'admit_block_ltc', 'admit_block_doge'])
        if(!nullableInteger(row[name])) fail('price', key, 'has malformed ' + name);
    for(let name of ['coin_pair', 'reference_chain', 'source_chain'])
        if(!text(row[name])) fail('price', key, 'has malformed ' + name);
    if(row.price !== null && typeof row.price !== 'string') fail('price', key, 'has malformed price');
    if(!PRICE_STATUSES.has(row.status)) fail('price', key, 'has malformed status');
    let proof = parsedProof(row);
    if(Array.isArray(proof)){
        if(!proof.every(validSignature)) fail('price', key, 'has malformed proof signatures');
        if(row.status === 'finalized' && proof.length === 0) fail('price', key, 'has empty finalized proof');
    } else if(!validBatchProof(proof)) fail('price', key, 'has malformed proof shape');
    if(!Array.isArray(proof) &&
       (row.round_number < proof.batch.first_round || row.round_number > proof.batch.last_round))
        fail('price', key, 'falls outside its batch proof range');
    return proof;
}

function validateTombstone(row){
    if(!row || typeof row !== 'object' || Array.isArray(row) || !integer(row.round_number) || !text(row.coin_pair))
        fail('price tombstone', priceKey(row), 'has malformed shape');
}

function verifyCheckpoints(rows, ctx){
    for(let row of rows){
        validateCheckpoint(row, ctx.network);
        let set = ctx.setFor('oracle_publish', row.snapshot_block);
        let sigs = ctx.parseSigs(row.validator_signatures);
        let weighted = swq.isStakeWeightedQuorumActive(row.snapshot_block, row.network);
        if(!ctx.quorumVerified(ctx.checkpointCanonical(row), sigs, set, weighted))
            fail('checkpoint', checkpointKey(row), 'fails quorum against the archived oracle_publish set');
    }
}

function signatureGroups(rows){
    let groups = new Map();
    for(let row of rows){
        let proof = validatePrice(row);
        if(Array.isArray(proof) && proof.length === 0) continue;
        let batch = !Array.isArray(proof);
        let key = (batch ? 'batch' : row.round_number) + '\0' + row.consensus_proof;
        if(!groups.has(key)) groups.set(key, { rows: [], proof, batch });
        groups.get(key).rows.push(row);
    }
    return groups.values();
}

function admitBlocks(row){
    if(row.admit_block_btc === null && row.admit_block_ltc === null && row.admit_block_doge === null) return null;
    return { BTC: row.admit_block_btc, LTC: row.admit_block_ltc, DOGE: row.admit_block_doge };
}

function sameSignedPriceFields(first, row){
    return ['round_number', 'reference_block', 'block_timestamp',
        'admit_block_btc', 'admit_block_ltc', 'admit_block_doge']
        .every(key => String(first[key]) === String(row[key]));
}

function batchRounds(group){
    let byRound = new Map();
    for(let row of group.rows){
        let key = Number(row.round_number);
        if(!byRound.has(key)) byRound.set(key, []);
        byRound.get(key).push(row);
    }
    let rounds = [...byRound.entries()].sort((a, b) => a[0] - b[0]).map(([round, rows]) => {
        let first = rows[0];
        if(rows.some(row => !sameSignedPriceFields(first, row)))
            fail('price batch', round, 'has inconsistent signed fields');
        return {
            round,
            timestamp: first.block_timestamp,
            btcBlockHeight: first.admit_block_btc == null ? first.reference_block : first.admit_block_btc,
            pairs: rows.map(row => ({ coinPair: row.coin_pair, price: row.price })),
            admitBlocks: admitBlocks(first)
        };
    });
    let batch = group.proof.batch;
    if(rounds.length !== batch.last_round - batch.first_round + 1 ||
       rounds[0].round !== batch.first_round || rounds[rounds.length - 1].round !== batch.last_round)
        fail('price batch', batch.first_round, 'does not contain its complete signed round range');
    return rounds;
}

function verifyBatchPriceGroup(group, ctx){
    let batch = group.proof.batch;
    let canonical = ed25519.buildPriceBatchPayload(batch.first_round, batch.last_round,
        batch.btc_block_height, batchRounds(group), ctx.network);
    let set = ctx.setFor('price', batch.btc_block_height);
    let sigs = ctx.parseSigs(group.proof.sigs);
    let weighted = swq.isStakeWeightedQuorumActive(batch.btc_block_height, ctx.network);
    if(!ctx.quorumVerified(canonical, sigs, set, weighted))
        fail('price batch', batch.first_round, 'fails quorum against the archived price set');
}

function verifyPrices(rows, ctx){
    for(let group of signatureGroups(rows)){
        if(group.batch){
            verifyBatchPriceGroup(group, ctx);
            continue;
        }
        let first = group.rows[0];
        if(group.rows.some(row => !sameSignedPriceFields(first, row)))
            fail('price round', first.round_number, 'has inconsistent signed fields');
        let pairs = group.rows.map(row => ({ coinPair: row.coin_pair, price: row.price }));
        let canonical = ed25519.buildPriceV0Payload(first.round_number, first.block_timestamp,
            pairs, ctx.network, first.reference_block, admitBlocks(first));
        let set = ctx.setFor('price', first.reference_block);
        let sigs = ctx.parseSigs(group.proof);
        let weighted = swq.isStakeWeightedQuorumActive(first.reference_block, ctx.network);
        if(!ctx.quorumVerified(canonical, sigs, set, weighted))
            fail('price round', first.round_number, 'fails quorum against the archived price set');
    }
}

function verifyArchive(archive, ctx){
    let checkpoints = archive.state_checkpoints || [];
    let prices = archive.price_snapshots || [];
    let tombstones = archive.price_tombstones || [];
    if(!Array.isArray(checkpoints) || !Array.isArray(prices) || !Array.isArray(tombstones))
        throw new Error('malformed checkpoint or price archive rows');
    verifyCheckpoints(checkpoints, ctx);
    verifyPrices(prices, ctx);
    for(let row of tombstones) validateTombstone(row);
}

function comparable(column, value){
    if(value === null || value === undefined) return null;
    if(['block_index', 'checkpoint_seq', 'snapshot_block', 'state_root_version',
        'block_merkle_version'].includes(column)) return Number(value);
    return String(value);
}

function checkpointDiffers(existing, row){
    return CHECKPOINT_COLUMNS.some(column => comparable(column, existing[column]) !== comparable(column, row[column]));
}

async function writeCheckpoint(db, row){
    let existing = await db.doQuery(
        `SELECT ${CHECKPOINT_COLUMNS.join(', ')} FROM state_checkpoints
         WHERE chain = ? AND network = ? AND checkpoint_seq = ? LIMIT 1`,
        [row.chain, row.network, Number(row.checkpoint_seq)]);
    if(existing && existing.length > 0){
        if(checkpointDiffers(existing[0], row)) fail('checkpoint', checkpointKey(row), 'collides with an existing checkpoint sequence');
        return;
    }
    await db.doQuery(
        `INSERT IGNORE INTO state_checkpoints
            (id, chain, network, block_index, block_hash, ledger_hash, actions_hash,
             contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version,
             block_merkle_root, block_merkle_version, validator_signatures)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [Number(row.id), row.chain, row.network, Number(row.block_index), row.block_hash,
         row.ledger_hash, row.actions_hash, row.contract_hash, Number(row.checkpoint_seq),
         Number(row.snapshot_block), row.state_root,
         row.state_root_version == null ? null : Number(row.state_root_version), row.block_merkle_root,
         row.block_merkle_version == null ? null : Number(row.block_merkle_version), row.validator_signatures]);
}

function priceValues(row){
    return [row.price, Number(row.reference_block), row.reference_chain, Number(row.block_timestamp),
        Number(row.validator_count), Number(row.consensus_round), row.consensus_proof, row.status,
        row.source_chain, row.source_action_index == null ? null : Number(row.source_action_index),
        Number(row.batch_block_time), row.admit_block_btc == null ? null : Number(row.admit_block_btc),
        row.admit_block_ltc == null ? null : Number(row.admit_block_ltc),
        row.admit_block_doge == null ? null : Number(row.admit_block_doge)];
}

async function writePrice(db, row){
    let existing = await db.doQuery(
        'SELECT round_number FROM price_snapshots WHERE round_number = ? AND coin_pair = ? LIMIT 1',
        [Number(row.round_number), row.coin_pair]);
    if(existing && existing.length > 0){
        await db.doQuery(
            `UPDATE price_snapshots SET price = ?, reference_block = ?, reference_chain = ?,
                 block_timestamp = ?, validator_count = ?, consensus_round = ?, consensus_proof = ?,
                 status = ?, source_chain = ?, source_action_index = ?, batch_block_time = ?,
                 admit_block_btc = ?, admit_block_ltc = ?, admit_block_doge = ?
             WHERE round_number = ? AND coin_pair = ?`,
            priceValues(row).concat([Number(row.round_number), row.coin_pair]));
        return;
    }
    await db.doQuery(
        `INSERT INTO price_snapshots
            (id, round_number, coin_pair, price, reference_block, reference_chain,
             block_timestamp, validator_count, consensus_round, consensus_proof, status,
             source_chain, source_action_index, batch_block_time,
             admit_block_btc, admit_block_ltc, admit_block_doge)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [Number(row.id), Number(row.round_number), row.coin_pair].concat(priceValues(row)));
}

async function writeArchive(db, archive, report){
    for(let row of (archive.state_checkpoints || [])){
        await writeCheckpoint(db, row);
        report.checkpoints++;
    }
    for(let row of (archive.price_snapshots || [])){
        await writePrice(db, row);
        report.prices++;
    }
    for(let row of (archive.price_tombstones || [])){
        await db.doQuery('DELETE FROM price_snapshots WHERE round_number = ? AND coin_pair = ?',
                         [Number(row.round_number), row.coin_pair]);
        report.tombstones++;
    }
}

module.exports = { verifyArchive, writeArchive };

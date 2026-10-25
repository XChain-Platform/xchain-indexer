/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
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
 * Event persistence for pre-rollback replay witnesses.
 *
 *********************************************************************/

'use strict';

const {
    decodeReplayWitnessPhase,
    replayWitnessBatch,
    rebuildWitnessMap,
    validateReplayWitnessWindows,
} = require('../../consensus/retroactive/replay_witness.js');

const REPLAY_WITNESS_WINDOW_CODE = 'CONSENSUS_RETRO_WITNESS_WINDOW';
const REPLAY_WITNESS_MAP_CODE = 'CONSENSUS_RETRO_WITNESS_MAP';
const REPLAY_WITNESS_PHASE_CODE = 'CONSENSUS_RETRO_WITNESS_PHASE';
const REPLAY_WITNESS_DATA_MAX = 250;
const DIGEST_RE = /^[0-9a-f]{64}$/;

function encodedRow(code, value){
    const data = JSON.stringify(value);
    if(Buffer.byteLength(data, 'utf8') >= REPLAY_WITNESS_DATA_MAX)
        throw new RangeError('replay witness row must stay under events.data width');
    return { code, data };
}

function encodedRows(witness){
    if(!witness || typeof witness !== 'object') throw new TypeError('replay witness is required');
    if(!DIGEST_RE.test(witness.batch)) throw new TypeError('replay witness batch is invalid');
    rebuildWitnessMap(witness.map, witness.rulesFrom);
    const phase = decodeReplayWitnessPhase(witness.phase);
    validateReplayWitnessWindows(witness.windows, phase);
    if(phase.rules_from !== witness.rulesFrom || phase.map_count !== witness.map.length ||
       replayWitnessBatch(phase.target, phase.replay_to, phase.rules_from, witness.windows) !== witness.batch)
        throw new Error('inconsistent replay witness');
    const rows = [];
    for(const window of witness.windows || [])
        rows.push(encodedRow(REPLAY_WITNESS_WINDOW_CODE, window));
    for(const entry of witness.map || [])
        rows.push(encodedRow(REPLAY_WITNESS_MAP_CODE, entry));
    rows.push(encodedRow(REPLAY_WITNESS_PHASE_CODE, phase));
    return rows;
}

async function recordReplayWitness(db, witness){
    const rows = encodedRows(witness);
    for(const row of rows){
        await db.doQueryStrict(
            'INSERT INTO events (time, code, data, witness_hash) VALUES (NOW(), ?, ?, ?)',
            [row.code, row.data, witness.batch]
        );
    }
    return rows;
}

async function recordReplayWitnessPhase(db, batch, phase){
    if(!DIGEST_RE.test(batch)) throw new TypeError('replay witness batch is invalid');
    const row = encodedRow(REPLAY_WITNESS_PHASE_CODE, decodeReplayWitnessPhase(phase));
    await db.doQueryStrict(
        'INSERT INTO events (time, code, data, witness_hash) VALUES (NOW(), ?, ?, ?)',
        [row.code, row.data, batch]
    );
}

// The indexer blocks table holds only this node's own digests; the chain block hash
// lives in the decoder database. Each hash is read with the same decoder statement the
// getblockhashes RPC reports (getDecoderBlockHashRow), uncased, so a witness row carries
// the hash a peer would see for that height. decoderDb is a committed-only view.
async function readReplayWitnessBlocks(db, decoderDb, target, replayTo){
    if(!decoderDb || typeof decoderDb.getDecoderBlockHashRow !== 'function')
        throw new TypeError('replay witness block read needs the decoder database');
    const rows = await db.doQueryStrict(
        'SELECT b.block_index, t1.hash AS ledger_hash, ' +
        't2.hash AS actions_hash, t3.hash AS contract_hash, str.state_root FROM blocks b ' +
        'LEFT JOIN index_transactions t1 ON (t1.id = b.ledger_hash_id) ' +
        'LEFT JOIN index_transactions t2 ON (t2.id = b.actions_hash_id) ' +
        'LEFT JOIN index_transactions t3 ON (t3.id = b.contract_hash_id) ' +
        'LEFT JOIN state_tree_roots str ON (str.block_index = b.block_index) ' +
        'WHERE b.block_index BETWEEN ? AND ? ORDER BY b.block_index ASC, b.id ASC',
        [target, replayTo]
    );
    const blocks = [];
    for(const row of rows || []){
        const hashRows = await decoderDb.getDecoderBlockHashRow(row.block_index);
        // getDecoderBlockHashRow answers [] on a decoder fault as well as on a missing
        // row; either way the window cannot be witnessed, so say which height failed
        // instead of letting the digest step report a malformed hash.
        if(!hashRows || hashRows.length === 0 || !hashRows[0].block_hash)
            throw new Error('replay witness block hash not readable from the decoder at block ' +
                row.block_index);
        blocks.push(Object.assign({}, row, { block_hash: String(hashRows[0].block_hash) }));
    }
    return blocks;
}

async function readLatestReplayWitness(db){
    const phaseRows = await db.doQueryStrict(
        'SELECT id, data, witness_hash FROM events WHERE code = ? ORDER BY id DESC LIMIT 1',
        [REPLAY_WITNESS_PHASE_CODE]
    );
    if(!phaseRows || phaseRows.length === 0) return null;
    const phaseRow = phaseRows[0];
    const batch = String(phaseRow.witness_hash || '');
    if(!DIGEST_RE.test(batch)) throw new Error('invalid replay witness batch');
    const phase = decodeReplayWitnessPhase(String(phaseRow.data));
    const readRows = async (code, count) => {
        const rows = await db.doQueryStrict(
            'SELECT data FROM events WHERE code = ? AND witness_hash = ? AND id < ? ' +
            'ORDER BY id DESC LIMIT ?',
            [code, batch, Number(phaseRow.id), count]
        );
        if(!rows || rows.length !== count) throw new Error('incomplete replay witness');
        return rows.slice().reverse();
    };
    const windows = (await readRows(REPLAY_WITNESS_WINDOW_CODE, phase.window_count))
        .map(row => JSON.parse(String(row.data)));
    validateReplayWitnessWindows(windows, phase);
    if(replayWitnessBatch(phase.target, phase.replay_to, phase.rules_from, windows) !== batch)
        throw new Error('invalid replay witness batch');
    const mapRows = await readRows(REPLAY_WITNESS_MAP_CODE, phase.map_count);
    const gateHeights = rebuildWitnessMap(mapRows, phase.rules_from);
    return { batch, phase, windows, gateHeights };
}

async function readReplayWitnessMap(db, batch, rulesFrom, mapCount, beforeId){
    const rows = await db.doQueryStrict(
        'SELECT data FROM events WHERE code = ? AND witness_hash = ? AND id < ? ' +
        'ORDER BY id DESC LIMIT ?',
        [REPLAY_WITNESS_MAP_CODE, batch, beforeId, mapCount]
    );
    if(!rows || rows.length !== mapCount) throw new Error('witness_map_mismatch');
    return rebuildWitnessMap(rows.slice().reverse(), rulesFrom);
}

module.exports = {
    REPLAY_WITNESS_WINDOW_CODE,
    REPLAY_WITNESS_MAP_CODE,
    REPLAY_WITNESS_PHASE_CODE,
    REPLAY_WITNESS_DATA_MAX,
    encodedRows,
    recordReplayWitness,
    recordReplayWitnessPhase,
    readReplayWitnessBlocks,
    readLatestReplayWitness,
    readReplayWitnessMap,
};

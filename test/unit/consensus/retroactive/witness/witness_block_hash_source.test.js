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
 * The replay witness takes each block's chain hash from the decoder, the
 * way getblockhashes reports it, over tables built from the real indexer
 * and decoder DDL; the indexer blocks table has no block_hash_id column.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');

const changes = require('../../../../../src/protocol_changes.js');
const blockMethods = require('../../../../../src/db/blocks/index.js');
const { buildSystemRpc } = require('../../../../../src/api/rpc/system.js');
const {
    REPLAY_WITNESS_PHASE_CODE,
    REPLAY_WITNESS_WINDOW_CODE,
    readReplayWitnessBlocks,
} = require('../../../../../src/db/events/retroactive_replay_witness.js');
const { makeWitnessEventsDb } = require('./helpers/witness_events_db.js');

const MOVABLE = 'movable_activation.MOVABLE_ACTIVATION';
const MARKER_INSERT = "INSERT INTO events (time, code, data) VALUES (NOW(), 'CONSENSUS_RETRO_REPLAY', ?)";
const HEIGHTS = [2, 3, 4];

function digest(value){
    return value.toString(16).padStart(64, '0');
}

// Height 3's chain hash is stored in upper case: getblockhashes reports it as stored,
// so the witness read must hand back the same string, not a folded copy.
function chainHash(height){
    const hash = ('a' + height.toString(16)).padEnd(64, String(height));
    return height === 3 ? hash.toUpperCase() : hash;
}

function seededDb(){
    return makeWitnessEventsDb({
        blocks: HEIGHTS.map(height => ({
            block_index: height,
            block_hash: chainHash(height),
            ledger_hash: digest(height + 10),
            actions_hash: digest(height + 11),
            contract_hash: digest(height + 12),
            state_root: digest(height + 20),
        })),
    });
}

function columns(sqlite, table){
    return sqlite.prepare('PRAGMA table_info(' + table + ')').all().map(column => column.name);
}

// The getblockhashes handler itself, over the same tables: its stored-triple read on
// the indexer side and its chain-hash read on the decoder side are the real methods.
function blockHashesRpc(db){
    const indexerDb = Object.assign(Object.create(db), {
        doQuery: db.doQueryStrict,
        getStoredBlockHashes: blockMethods.getStoredBlockHashes,
    });
    return buildSystemRpc({
        indexer: {
            config: { COIN: 'BTC', NETWORK: 'regtest' },
            indexerDb,
            decoderDb: db.decoderDb,
            replayMarker: null,
        },
    });
}

// startup.js with one movable gate, loaded fresh so the stub reaches gate_heights and
// boot_replay; the module cache is put back afterwards.
function startupWithMovableGate(){
    const movablePath = require.resolve('../../../../../src/consensus/retroactive/movable_gates.js');
    const gatesPath = require.resolve('../../../../../src/consensus/retroactive/gate_heights.js');
    const bootPath = require.resolve('../../../../../src/consensus/retroactive/boot_replay.js');
    const startupPath = require.resolve('../../../../../src/XChainIndexer/startup.js');
    const paths = [movablePath, gatesPath, bootPath, startupPath];
    const saved = new Map(paths.map(file => [file, require.cache[file]]));
    for(const file of paths) delete require.cache[file];
    require.cache[movablePath] = {
        id: movablePath,
        filename: movablePath,
        loaded: true,
        exports: { MOVABLE_GATES: Object.freeze([MOVABLE]) },
    };
    const startup = require(startupPath);
    for(const file of paths){
        delete require.cache[file];
        if(saved.get(file)) require.cache[file] = saved.get(file);
    }
    return startup;
}

// Each witness row against the getblockhashes response for its height.
async function assertRowsMatchRpc(rows, rpc){
    for(const row of rows){
        const reported = await rpc.getblockhashes({ block_index: row.block_index });
        assert.strictEqual(reported.error, undefined);
        assert.strictEqual(row.block_hash, reported.block_hash);
        assert.strictEqual(row.block_hash, chainHash(row.block_index));
        for(const field of ['ledger_hash', 'actions_hash', 'contract_hash', 'state_root'])
            assert.strictEqual(row[field], reported[field]);
    }
}

// The indexer side of a boot whose recorded movable gate (10) moved below the applied
// tip (4) to 2: the boot must witness 2..4, write the marker and roll back to 2.
function movableGateDb(db, markers){
    const query = db.doQueryStrict;
    return Object.assign(db, {
        async doQueryStrict(sql, params){
            if(sql === MARKER_INSERT){
                markers.push(JSON.parse(params[0]).state);
                return { insertId: markers.length, affectedRows: 1 };
            }
            return query(sql, params);
        },
        getBlockIndex: async () => 4,
        consensusHeightGateMap: () => ({ [MOVABLE]: 2 }),
        readConsensusGateBoot: async () => ({
            recorded: { gateHeights: { [MOVABLE]: 10 }, appliedTip: 4, scope: 'registry' },
            replayMarker: null,
        }),
        recordConsensusGateBoot: async () => {},
        readRetroactiveMirrorCoverage: async () => ({
            targetBlockTime: 1000000,
            oldestPriceRoundTime: 1,
            requiredCapabilityBlock: null,
            oldestCapabilitySnapshotBlock: null,
        }),
    });
}

function movableGateIndexer(startup, db, rollbacks){
    return {
        config: {
            NETWORK: 'regtest',
            COIN: 'LTC',
            RETROACTIVE_REPLAY_CAP_BLOCKS: 10,
            FIAT_DISPENSER_PRICE_WINDOW: 86400,
        },
        indexerDb: db,
        decoderDb: db.decoderDb,
        rollback: { rollback: async target => rollbacks.push(target) },
        util: { throwError(message){ throw new Error(message); } },
        holdRetroactiveReplay: startup.holdRetroactiveReplay,
        holdRetroactiveReplayNeedsGo: startup.holdRetroactiveReplayNeedsGo,
        holdRetroactiveReplayDiverged: startup.holdRetroactiveReplayDiverged,
        recordConsensusGateBoot: startup.recordConsensusGateBoot,
    };
}

describe('retroactive witness block hash source @regression @tier1', function(){
    it('reads each block hash as getblockhashes reports it, over the real indexer and decoder DDL', async function(){
        const db = seededDb();
        assert.strictEqual(columns(db.indexerSqlite, 'blocks').includes('block_hash_id'), false);
        assert.strictEqual(columns(db.decoderSqlite, 'blocks').includes('block_hash_id'), true);
        assert.throws(() => db.indexerSqlite.prepare(
            'SELECT t.hash FROM blocks b JOIN index_transactions t ON t.id = b.block_hash_id'),
            /no such column: b\.block_hash_id/);

        const rows = await readReplayWitnessBlocks(db, db.decoderDb, 2, 4);

        assert.deepStrictEqual(rows.map(row => row.block_index), HEIGHTS);
        await assertRowsMatchRpc(rows, blockHashesRpc(db));
        assert.ok(db.queries.every(query => !/block_hash_id/.test(query.sql)));
        assert.ok(db.decoderDb.queries.some(query => /b\.block_hash_id/.test(query.sql)));
    });

    it('refuses a window whose block hash the decoder cannot supply', async function(){
        const db = makeWitnessEventsDb({
            blocks: [{ block_index: 2, block_hash: chainHash(2) }, { block_index: 3 }],
        });

        await assert.rejects(readReplayWitnessBlocks(db, db.decoderDb, 2, 3),
            /block hash not readable from the decoder at block 3/);
        await assert.rejects(readReplayWitnessBlocks(db, null, 2, 3),
            /needs the decoder database/);
    });

    it('records the witness and rolls back when startup boots across a movable gate', async function(){
        const startup = startupWithMovableGate();
        const markers = [];
        const rollbacks = [];
        const db = movableGateDb(seededDb(), markers);
        const indexer = movableGateIndexer(startup, db, rollbacks);
        const originalOverlay = changes.registry.getReadOverlay();

        try {
            await indexer.recordConsensusGateBoot();
        } finally {
            changes.registry.setReadOverlay(originalOverlay);
        }

        assert.ok(db.events.some(event => event.code === REPLAY_WITNESS_WINDOW_CODE));
        assert.ok(db.events.some(event => event.code === REPLAY_WITNESS_PHASE_CODE));
        assert.deepStrictEqual(rollbacks, [2]);
        assert.deepStrictEqual(markers, ['pending', 'replaying']);
        assert.strictEqual(indexer.replayWitness.phase.phase, 'witness');
        assert.strictEqual(indexer.replayWitness.phase.target, 2);
        assert.ok(db.queries.every(query => !/block_hash_id/.test(query.sql)));
        assert.ok(db.decoderDb.queries.length >= HEIGHTS.length);
    });
});

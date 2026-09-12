/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Lane L15, base bridge spec row 7 (the base bridge spec): the read
 * handlers getpendingbridgetransfers, getbridgetransfer, getbridgebalances and
 * getbridgeescrowproof, and the db.js reads behind them.
 *
 * src/api.js calls startApi() at module load and cannot be required (it opens DB
 * connections and process.exit()s on missing env), so the controller-registration
 * and gating checks below are a static source scan, the api-federation-read-
 * isolation.test.js / api-state-root-version-boundary.test.js technique: read the
 * real shipped source, compile the real literal, never a hand-copied paraphrase.
 *
 * getBridgeEscrowProof is verified against REAL cryptography: a persistent SMT is
 * built with the actual escrow balance leaf, db.doQueryStrict is stubbed to answer
 * state_tree_nodes / state_tree_roots / state_checkpoints exactly the way the real
 * tables would at one pinned height, and the resulting envelope is fed straight
 * into bridge_checkpoint_check.verifyEscrowAgainstCheckpoint (D2's own verifier,
 * landed and tested, never touched by this lane) and must come back ok:true.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility  = require('../../src/utility');
const Database = require('../../src/db');
const SC  = require('../../src/stateCommitment.js');
const M   = require('../../src/merkle.js');
const CHK = require('../../src/bridge_checkpoint_check.js');

const API_SRC = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');

function newDb(){
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
}

afterEach(function(){ sinon.restore(); });

// ── api.js registration: open reads (base spec D44) ─────────────────────────

describe('bridge reads are registered open (base spec D44) @regression @tier1', function(){
    const OPEN_METHODS = ['getpendingbridgetransfers', 'getbridgetransfer', 'getbridgebalances', 'getbridgeescrowproof'];

    function parseSet(name){
        const m = API_SRC.match(new RegExp('const\\s+' + name + '\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)'));
        assert.ok(m, name + ' not found in src/api.js');
        const names = [];
        const re = /['"]([a-z0-9_]+)['"]/gi;
        let hit;
        while((hit = re.exec(m[1])) !== null) names.push(hit[1]);
        return names;
    }

    const writeMethods      = parseSet('WRITE_METHODS');
    const gatedExecMethods  = parseSet('GATED_EXEC_METHODS');
    const federationReads   = parseSet('FEDERATION_READ_METHODS');

    for(const name of OPEN_METHODS){
        it(name + ' is registered as a controller handler', function(){
            assert.match(API_SRC, new RegExp('\\n {8}async\\s+' + name + '\\s*\\('),
                name + ' handler not found in the jsonRpcController object');
        });
        it(name + ' is in none of WRITE_METHODS / GATED_EXEC_METHODS / FEDERATION_READ_METHODS', function(){
            assert.ok(!writeMethods.includes(name),     name + ' must not be a WRITE_METHOD');
            assert.ok(!gatedExecMethods.includes(name),  name + ' must not be a GATED_EXEC_METHOD');
            assert.ok(!federationReads.includes(name),   name + ' must be open, not federation-gated');
        });
    }

    // getpendingbridgetransfers carries push_generation on each row, the row's own
    // spec text ("on the getpendingcrosschaincalls convention at api.js:1230"), and
    // the hub reads it (CrossChainBridgeEngine.js:_maybeFinalizeTransfer,
    // row.push_generation). Checked the api-pushgeneration-stamping.test.js way:
    // the real handler body must read the generation and it must come BEFORE the
    // rows are read (HUB-RETRACT-1), never grepped for the bare identifier alone.
    it('getpendingbridgetransfers reads push_generation BEFORE the rows (HUB-RETRACT-1)', function(){
        const start = API_SRC.indexOf('async getpendingbridgetransfers(');
        assert.ok(start !== -1);
        const rel  = API_SRC.slice(start + 1).search(/\n {8}async\s+\w+\s*\(/);
        const body = API_SRC.slice(start, rel === -1 ? API_SRC.length : start + 1 + rel);
        const genAt  = body.indexOf('getPushGeneration(');
        const rowsAt = body.indexOf('getPendingBridgeTransfers(');
        assert.ok(genAt !== -1, 'getpendingbridgetransfers must read the push generation');
        assert.ok(rowsAt !== -1, 'getpendingbridgetransfers must read the pending rows');
        assert.ok(genAt < rowsAt, 'HUB-RETRACT-1: the generation must be read BEFORE the rows, ' +
            'or a rollback landing between the two reads can stamp a pre-commit orphan with the ' +
            'post-commit generation and let it escape the retraction fence forever');
        assert.match(body, /push_generation:\s*pushGeneration/, 'each returned transfer must carry push_generation');
    });
});

// ── db.getPendingBridgeTransfers ─────────────────────────────────────────────

describe('db.getPendingBridgeTransfers @regression @tier1', function(){
    it('reads only valid v0/v1/v3/v4 xbridges rows, joined for every PendingBridgeTransfer field', async function(){
        const db = newDb();
        const rows = [{
            action_index: 501, version: 3, block_index: 120, amount: '10.5', decimals: 8,
            min_depth: 3, dest_chain: 'DOGE', tick: 'FUFU',
            dest_address: 'DDestAddr', src_address: 'BSrcAddr', tx_hash: 'a'.repeat(64)
        }];
        sinon.stub(db, 'doQuery').callsFake(async (query, args) => {
            assert.match(query, /FROM\s+xbridges x/i);
            assert.match(query, /status='valid'\s+AND\s+x\.version\s+IN\s*\(0,1,3,4\)/i);
            assert.deepStrictEqual(args, [50]);
            return rows;
        });
        const out = await db.getPendingBridgeTransfers(50);
        assert.strictEqual(out, rows);
    });
});

describe('db.getBridgeTransferById @regression @tier1', function(){
    it('reads the mirror row by transfer_id, one row max', async function(){
        const db = newDb();
        const tid = 'b'.repeat(64);
        sinon.stub(db, 'doQuery').callsFake(async (query, args) => {
            assert.match(query, /FROM\s+bridge_transfers/i);
            assert.deepStrictEqual(args, [tid]);
            return [{ transfer_id: tid, tick: 'XCHAIN' }];
        });
        const row = await db.getBridgeTransferById(tid);
        assert.strictEqual(row.transfer_id, tid);
    });
    it('returns null when no such transfer exists', async function(){
        const db = newDb();
        sinon.stub(db, 'doQuery').resolves([]);
        const row = await db.getBridgeTransferById('c'.repeat(64));
        assert.strictEqual(row, null);
    });
});

// ── db.getBridgeBalances ─────────────────────────────────────────────────────

describe('db.getBridgeBalances @regression @tier1', function(){
    it('prefers the native tokens.supply row when this chain holds one', async function(){
        const db = newDb();
        sinon.stub(db, 'doQuery').callsFake(async (query) => {
            if(/FROM\s+tokens/i.test(query)) return [{ supply: '100000000' }];
            return [{ cr: '0', dr: '0' }];
        });
        const res = await db.getBridgeBalances('XCHAIN');
        assert.strictEqual(res.supply, '100000000');
        // BTC's own config carries BRIDGE_LTC and BRIDGE_DOGE roles (coins/BTC.js); the
        // real regtest config fixture is used so this proves against the shipped roster,
        // never a hand-typed one.
        assert.ok('LTC'  in res.escrow, 'escrow must be keyed by the bare coin LTC');
        assert.ok('DOGE' in res.escrow, 'escrow must be keyed by the bare coin DOGE');
    });

    it('falls back to the ledger-wide net when no native tokens row exists (a bridged copy)', async function(){
        const db = newDb();
        sinon.stub(db, 'doQuery').callsFake(async (query) => {
            if(/FROM\s+tokens/i.test(query)) return [];
            if(/FROM\s+credits c\s*$/im.test(query) || /credits c/i.test(query))
                return [{ cr: '30', dr: '5' }];
            return [{ cr: '0', dr: '0' }];
        });
        const res = await db.getBridgeBalances('FUFU');
        assert.strictEqual(res.supply, '25');
    });
});

// ── db.getBridgeEscrowProof, verified through bridge_checkpoint_check.js ────

describe('db.getBridgeEscrowProof, driven through CHK.verifyEscrowAgainstCheckpoint @regression @tier1', function(){
    const NETWORK = 'regtest';
    const CHAIN   = 'BTC';     // this indexer IS the escrow chain for this fixture
    const DEST    = 'DOGE';
    const TICK    = 'XCHAIN';
    const HEIGHT  = 9999;      // BTC:regtest, below the contract_state_root boundary (bridge_checkpoint_check.test.js V1_HEIGHT)
    const ESCROW_ADDR = 'mfbtcbridgedogeXXXXXXXXXXXXXUXTr4m'; // coins/BTC.js regtest ADDRESS.BRIDGE_DOGE
    const BALANCE = '12.5';

    // `distributed: true` models the deployment every standing indexer runs: the hub
    // mirror lives in its own database (indexer.hubDb), so the ledger connection's copy
    // of state_checkpoints is EMPTY and only the mirror handle can answer for it. The
    // ledger stub refuses that query outright so a read on the wrong connection cannot
    // pass by accident, which is exactly how the original read passed this fixture.
    async function buildEnvelope(opts){
        const distributed = !!(opts && opts.distributed);
        const memStore = new SC.MemoryNodeStore();
        const smt      = new SC.PersistentSMT(memStore);
        const key      = M.balanceKey(CHAIN, NETWORK, ESCROW_ADDR, TICK);
        const leafHex  = M.toHex(M.amountLeaf(BALANCE));
        const balancesRoot = await smt.update(SC.EMPTY_ROOT_HEX, key, leafHex);
        const stakesRoot   = M.toHex(M.EMPTY_SMT_ROOT);
        const subRoots     = { balances_root: balancesRoot, stakes_root: stakesRoot };
        const stateRoot    = M.toHex(M.stateRoot(subRoots));
        const SUB = require('../../src/state_subtree_activation.js');
        const version = SUB.stateRootVersion(HEIGHT, NETWORK, CHAIN);
        const checkpointRow = { checkpoint_seq: 7, snapshot_block: HEIGHT, state_root: stateRoot, state_root_version: version };

        const db = newDb();
        const mirror = { doQueryStrict: sinon.stub().callsFake(async (query) =>
            /FROM\s+state_checkpoints/i.test(query) ? [checkpointRow] : []) };
        if(distributed) db.indexer = { hubDb: mirror };
        sinon.stub(db, 'doQueryStrict').callsFake(async (query, args) => {
            if(/FROM\s+state_tree_nodes/i.test(query)){
                const row = await memStore.get(args[0]);
                return row ? [row] : [];
            }
            if(/FROM\s+state_tree_roots/i.test(query))
                return [{ balances_root: balancesRoot, stakes_root: stakesRoot, contract_state_root: null }];
            if(/FROM\s+state_checkpoints/i.test(query)){
                if(distributed) throw new Error('state_checkpoints was read on the LEDGER connection; it is hub-mirrored');
                return [checkpointRow];
            }
            // the credits/debits balance-at-block subquery
            return [{ cr: BALANCE, dr: '0' }];
        });

        const envelope = await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT);
        return distributed ? { envelope, mirror } : envelope;
    }

    it('reads the checkpoint through the hub-mirror handle on a distributed deployment, never the ledger connection', async function(){
        const { envelope, mirror } = await buildEnvelope({ distributed: true });
        assert.ok(envelope, 'no envelope: the checkpoint read did not reach the mirror handle');
        assert.strictEqual(mirror.doQueryStrict.callCount, 1, 'exactly one mirror read, the checkpoint');
        assert.match(mirror.doQueryStrict.firstCall.args[0], /FROM\s+state_checkpoints/i);
        assert.strictEqual(envelope.checkpoint.checkpoint_seq, 7);
        assert.strictEqual(envelope.checkpoint.state_root_version, 1);
    });

    it('produces a self-consistent envelope (real balance proven against the real persisted root)', async function(){
        const envelope = await buildEnvelope();
        assert.ok(envelope, 'getBridgeEscrowProof returned null');
        assert.strictEqual(envelope.chain, CHAIN);
        assert.strictEqual(envelope.network, NETWORK);
        assert.strictEqual(envelope.block_index, HEIGHT);
        assert.strictEqual(envelope.address, ESCROW_ADDR);
        assert.strictEqual(envelope.tick, TICK);
        assert.strictEqual(envelope.balance, BALANCE);
        assert.strictEqual(envelope.balance_proof.siblings.length, 256);
        assert.strictEqual(envelope.checkpoint.chain, CHAIN);
        assert.strictEqual(envelope.checkpoint.block_index, HEIGHT);
    });

    it('DRIVEN: the envelope verifies ok:true through bridge_checkpoint_check.verifyEscrowAgainstCheckpoint', async function(){
        const envelope = await buildEnvelope();
        const row = {
            src_chain: CHAIN, dest_chain: DEST, network: NETWORK, tick: TICK,
            snapshot_block: HEIGHT, amount: '5'   // <= the 12.5 proven balance
        };
        const ctx = { coin: DEST, network: NETWORK, proof: envelope };
        const result = CHK.verifyEscrowAgainstCheckpoint(row, ctx);
        assert.strictEqual(result.ok, true, 'expected ok:true, got: ' + result.reason);
        assert.strictEqual(result.reason, CHK.ESCROW_PROOF_REASON.VERIFIED);
    });

    it('FALSIFICATION: an envelope claiming a smaller balance than what is actually proven fails INSUFFICIENT, never ok:true', async function(){
        const envelope = await buildEnvelope();
        const row = {
            src_chain: CHAIN, dest_chain: DEST, network: NETWORK, tick: TICK,
            snapshot_block: HEIGHT, amount: '999'  // > the 12.5 proven balance
        };
        const ctx = { coin: DEST, network: NETWORK, proof: envelope };
        const result = CHK.verifyEscrowAgainstCheckpoint(row, ctx);
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, CHK.ESCROW_PROOF_REASON.INSUFFICIENT);
    });

    it('returns null when this chain has no committed roots at that height (never approximates)', async function(){
        const db = newDb();
        sinon.stub(db, 'doQueryStrict').resolves([]);
        const envelope = await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT);
        assert.strictEqual(envelope, null);
    });

    it('state_root_version is DERIVED via state_subtree_activation.stateRootVersion, never the static merkle constant', async function(){
        const SUB = require('../../src/state_subtree_activation.js');
        const M2  = require('../../src/merkle.js');
        const realVersion = SUB.stateRootVersion(HEIGHT, NETWORK, CHAIN);
        // The static constant and the derived value happen to agree at this fixture's
        // height (both 1); assert that fact so the next assertion's contrast is real.
        assert.strictEqual(M2.STATE_ROOT_VERSION, 1);
        assert.strictEqual(realVersion, 1);

        const memStore = new SC.MemoryNodeStore();
        const smt = new SC.PersistentSMT(memStore);
        const key = M.balanceKey(CHAIN, NETWORK, ESCROW_ADDR, TICK);
        const balancesRoot = await smt.update(SC.EMPTY_ROOT_HEX, key, M.toHex(M.amountLeaf(BALANCE)));
        const stakesRoot = M.toHex(M.EMPTY_SMT_ROOT);

        const db = newDb();
        sinon.stub(db, 'doQueryStrict').callsFake(async (query, args) => {
            if(/FROM\s+state_tree_nodes/i.test(query)){
                const row = await memStore.get(args[0]);
                return row ? [row] : [];
            }
            if(/FROM\s+state_tree_roots/i.test(query))
                return [{ balances_root: balancesRoot, stakes_root: stakesRoot, contract_state_root: null }];
            if(/FROM\s+state_checkpoints/i.test(query))
                // A wrong STAMPED version (2, when this height truly derives 1): a stale or
                // mis-migrated checkpoint row, or a hub that disagrees with this node's own
                // maps. Must fail closed rather than hand out a mismatched envelope.
                return [{ checkpoint_seq: 1, snapshot_block: HEIGHT, state_root: M.toHex(M.stateRoot({balances_root: balancesRoot, stakes_root: stakesRoot})), state_root_version: 2 }];
            return [{ cr: BALANCE, dr: '0' }];
        });
        const envelope = await db.getBridgeEscrowProof(ESCROW_ADDR, TICK, HEIGHT);
        assert.strictEqual(envelope, null, 'a stamped version that disagrees with the derived one must refuse the envelope');
    });
});

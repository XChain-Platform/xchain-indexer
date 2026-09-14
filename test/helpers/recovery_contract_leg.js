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
 **********************************************************************
 *
 * The contract-heavy leg of test/integration/recovery_determinism_e2e.test.js:
 * the chunked contract, the real VM its DEPLOY needs, and the row readers the
 * byte-identity assertions compare. test/helpers/recovery_determinism_nodes.js
 * drives it on both nodes, after the recovery pre-seed.
 *
 ********************************************************************/
'use strict';

const assert = require('assert');
const crypto = require('crypto');

const { getTestConfig } = require('../fixtures/config');
const Deploy = require('../../src/actions/deploy/index.js');
const Mapper = require('../../src/chain/mapper.js');

// ── Contract-heavy recovery leg ────────────────────────────────────
// The launch bundle deploys contracts via chunked DEPLOY: a run of v4 carriers each
// carrying one ordered base64 slice of the source, then a v2/v3 that reassembles the
// slices (keyed on CODE_HASH), sha256-verifies, and creates the contract. This leg
// re-confirms that a contract-heavy chain reindexes byte-identically across the recovery
// boundary: node A deploys it from-genesis, node B deploys the SAME contract after the
// real AnchorRecovery pre-seed, and their `contracts` + `deploy_chunks` rows must match
// row-for-row - including source_id, which is an index_addresses id (the recovery determinism
// guarantee that recovery's out-of-band pre-seed does not offset the id map, here proven to
// carry through to a contract's on-chain deployer binding). Node B records its carriers in a
// DIFFERENT physical order than node A, so the match also pins the assembler's
// ORDER BY chunk_index, action_index against a real engine (delivery-order independence).
const CONTRACT_DEPLOYER = 'btc1qAaa';   // created in CHAIN block 1 (has a deterministic id on both nodes)
const CONTRACT_BLOCK    = 5;            // after EARN/COLLECT so the deploy never perturbs the reward assertions
// `meta` first, because this handler's protocolChanges stub answers enabled for every
// gate, CONTRACT_META_REQUIRED included, and a nameless assembled source is then
// `invalid: CONTRACT_MANIFEST (meta required)` at the completing piece of the assembled source.
const CONTRACT_CODE     = "module.exports = { meta: { name: 'Recovery Fixture',"
                        + " description: 'Chunked-deploy recovery byte-identity fixture.', version: '1.0.0' },"
                        + ' run: function(state, params) { return { value: 42 }; } };'
                        + ' // chunked-DEPLOY recovery byte-identity regression: padded to force a multi-slice base64 body split across v4 carriers';
const CONTRACT_HASH     = crypto.createHash('sha256').update(Buffer.from(CONTRACT_CODE, 'utf8')).digest('hex');
const CONTRACT_CHUNKS   = 3;
// Carrier action indices, one per chunk position, all below the assembling DEPLOY's index
// so getDeployChunksForAssembly consumes them. Keyed by position, NOT by insertion order.
const CARRIER_INDEX     = { 0: 5001, 1: 5002, 2: 5003 };
const ASSEMBLE_INDEX    = 5010;

// The REAL xchain-vm, built once and shared by both nodes' DEPLOY handlers.
//
// Passing `vm: null` here rests on the theory that the chunked-assembly + code_hash path
// never runs VM code. That is true of the v4 CARRIERS (deploy.js delegates them to
// DeployChunk before any VM work) but never of the v2 ASSEMBLY, and it is not survivable
// under deploy.js's fail-CLOSED guard: a DEPLOY reaching the shared validation path with
// no executor throws EXECUTOR_UNAVAILABLE rather than skipping the syntax/manifest gate,
// because a VM-less node that recorded such a deploy VALID would fork the ledger against
// the rest of the fleet. So the fixture needs a real executor; the product is correct and
// a VM-less fixture is the thing that would be stale.
//
// Only the syntax + manifest gates actually run here: CONSTRUCTOR_PARAMS is empty on the
// assembling DEPLOY, so runConstructor is false and no contract code executes.
let vmInstance;
let vmLoadFailed = false;
function sharedVm() {
    if (vmInstance || vmLoadFailed) return vmInstance || null;
    try {
        const XChainVM = require('xchain-vm');
        // Same subprocess executor the indexer runs in production (src/actions/index.js), so the
        // gates this fixture drives are the ones a real node applies.
        vmInstance = new XChainVM({
            execution:   'subprocess',
            gasSchedule: getTestConfig()['GAS_SCHEDULE'],
            gasCeiling:  1000000,
            limits:      { maxCpuTimeMs: 30000, maxMemory: 8, maxEmissions: 50,
                           maxStateKeys: 10000, maxStateValueSize: 65536,
                           maxCodeSize: Deploy.MAX_CODE_SIZE },
        });
    } catch (e) {
        // xchain-vm is a file: dependency whose vendored directory is untracked, so a tree
        // assembled without it cannot run this leg. Skip that leg loudly rather than
        // reporting a venue gap as a consensus failure (the trap records twice)
        // bin/run-db-tiers.sh refuses to start a tier at all in that state.
        vmLoadFailed = true;
        console.log('WARNING: xchain-vm unavailable; SKIPPING the chunked-DEPLOY recovery leg ' +
                    '(tests 5/6). This is a VENUE gap, not a passing consensus check: ' + e.message);
    }
    return vmInstance || null;
}

/** Close the VM subprocess, if one was started, so the run can exit. */
async function shutdownVm() {
    if (!vmInstance) return;
    try { await vmInstance.shutdown(); } catch (e) {}
    vmInstance = null;
}

// A DEPLOY handler bound to one real indexer DB. GAS_PRICE '0' (fee 0 -> the balance/
// native-fee legs are skipped, so no gas token needs seeding); protocolChanges is stubbed
// enabled because this regtest node is genesis-active for every DEPLOY gate. This drives the
// REAL Deploy / DeployChunk handlers so the assertions cover the shipped assembler, not a
// reimplementation. `util` is the suite's one Utility, shared with the node databases.
function makeDeployHandler(db, util) {
    const config = getTestConfig();
    config['GAS_PRICE'] = '0';
    const mapper = new Mapper({ config, decoderDb: db, indexerDb: db, util });
    const action = { config, decoderDb: db, indexerDb: db, util, mapper,
                     protocolChanges: { isEnabled: async () => true }, vm: sharedVm() };
    return new Deploy(action);
}

// Deploy the chunked contract on `db`: record the CONTRACT_CHUNKS v4 carriers (in `insertOrder`,
// a permutation of the positions) then run the v2 assembly. Wrapped in one block transaction,
// mirroring how the indexer processes a block.
async function deployChunkedContract(db, insertOrder, util) {
    const handler = makeDeployHandler(db, util);
    const b64  = Buffer.from(CONTRACT_CODE, 'utf8').toString('base64');
    const size = Math.ceil(b64.length / CONTRACT_CHUNKS);
    const slice = (i) => b64.slice(i * size, (i + 1) * size);
    await db.beginTransaction();
    db.blockIndex = CONTRACT_BLOCK;
    for (const pos of insertOrder) {
        util.resetLists();
        const data = { ACTION: 'DEPLOY', SOURCE: CONTRACT_DEPLOYER, BLOCK_INDEX: CONTRACT_BLOCK,
                       BLOCK_TIME: 1700000000, TX_HASH: 'aa'.repeat(32), TX_INDEX: 0, TX_VOUT: 0,
                       FORMAT: 4, ACTION_INDEX: CARRIER_INDEX[pos] };
        await handler.parse(['4', CONTRACT_HASH, String(pos), String(CONTRACT_CHUNKS), slice(pos)], data, null);
        assert.strictEqual(data['STATUS'], 'valid', 'v4 carrier ' + pos + ' must store valid: ' + data['STATUS']);
    }
    util.resetLists();
    const data = { ACTION: 'DEPLOY', SOURCE: CONTRACT_DEPLOYER, BLOCK_INDEX: CONTRACT_BLOCK,
                   BLOCK_TIME: 1700000000, TX_HASH: 'aa'.repeat(32), TX_INDEX: 0, TX_VOUT: 0,
                   FORMAT: 2, ACTION_INDEX: ASSEMBLE_INDEX };
    await handler.parse(['2', CONTRACT_HASH, '100000', ''], data, null);
    assert.strictEqual(data['STATUS'], 'valid', 'v2 chunked-assembly deploy must be valid: ' + data['STATUS']);
    await db.commitTransaction();
}

// contracts rows, status resolved to its STRING (index_statuses ids are per-DB surrogates and
// NOT part of the recovery id-map guarantee, so compare by status text; source_id IS an
// index_addresses id and IS guaranteed identical, so it stays in the comparison).
async function contractRows(db) {
    const rows = await db.doQuery(
        "SELECT c.action_index, c.source_id, c.code, c.code_hash, c.api_version, s.status AS status, c.block_index " +
        "FROM contracts c JOIN index_statuses s ON s.id = c.status_id ORDER BY c.action_index");
    return rows.map(r => ({
        action_index: String(r.action_index), source_id: String(r.source_id),
        code: String(r.code), code_hash: String(r.code_hash),
        api_version: String(r.api_version), status: String(r.status), block_index: String(r.block_index),
    }));
}

async function deployChunkRows(db) {
    const rows = await db.doQuery(
        "SELECT dc.chunk_index, dc.total_chunks, dc.code_part, dc.source_id, dc.code_hash, st.status AS status " +
        "FROM deploy_chunks dc JOIN index_statuses st ON st.id = dc.status_id ORDER BY dc.chunk_index");
    return rows.map(r => ({
        chunk_index: String(r.chunk_index), total_chunks: String(r.total_chunks),
        code_part: String(r.code_part), source_id: String(r.source_id),
        code_hash: String(r.code_hash), status: String(r.status),
    }));
}

module.exports = {
    CONTRACT_DEPLOYER, CONTRACT_CODE, CONTRACT_HASH, CONTRACT_CHUNKS,
    sharedVm, shutdownVm, deployChunkedContract, contractRows, deployChunkRows,
};

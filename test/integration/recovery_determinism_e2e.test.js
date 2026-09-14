/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
 * RECOVERY-DETERMINISM E2E (consensus) - deterministic id-map gate.
 *
 * The full cross-node proof that recovery is deterministic for the id map: build a
 * from-genesis node A and a recovered node B over the IDENTICAL chain, where the
 * only difference is HOW the anchor reward arrives:
 *
 *   - Node A (from-genesis): processes the chain in-block, then the live hub push
 *     writes the anchor reward via the REAL createValidatorReward (source resolved
 *     through the on-chain stake).
 *   - Node B (recovered): the REAL AnchorRecovery.run() restores a signed archive
 *     carrying the same reward (stages it by raw source-address string into
 *     recovery_pending_rewards), THEN the BTC reindex replays the identical chain
 *     (createAddress assigning the deterministic ids) and materializes the reward
 *     under that deterministic source_id when it reaches the block the reward was
 *     first derived at.
 *
 * Asserts the three recovery invariants:
 *   (1) computeIndexMapChecksum(A) == computeIndexMapChecksum(B)   (the id map)
 *   (2) validator_rewards rows byte-identical A vs B                (reward parity)
 *   (3) getUnclaimedRewardTotal(source) equal A vs B               (COLLECT total)
 *
 * Without a deterministic id map this forks: an out-of-band pre-seed offsets node B's whole id
 * map, so (1) and (2) diverge. Needs a real MariaDB; set TEST_DB_HOST/PORT/USER/
 * PASS (self-skips without TEST_DB_PASS). Runs in CI via the integration tier's
 * test/integration/** glob, which provides the DB service.
 *
 * WHERE THE FIXTURE LIVES. The two nodes, the chain they replay and the row readers
 * are recovery_determinism_e2e.test/helpers/recovery_determinism_nodes.js beside this
 * file; the chunked contract and the real VM its DEPLOY needs are
 * recovery_determinism_e2e.test/helpers/recovery_contract_leg.js. The cases below are three
 * describe blocks with one title, so every full test title reads as it did when they
 * were one block, and all three read the same two nodes, built once.
 *
 ********************************************************************/
'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert = require('assert');

const { buildStateHashData, INDEX_MAP_STATE_HASH_ACTIVATION } = require('../../src/stateHash');
const {
    util, CHAIN, STAKE_SOURCE, EARN_BLOCK, COLLECT_BLOCK,
    indexMapChecksum, rewardRows, useRecoveredNodes, teardownRecoveredNodes,
} = require('./recovery_determinism_e2e.test/helpers/recovery_determinism_nodes');
const {
    CONTRACT_DEPLOYER, CONTRACT_CODE, CONTRACT_HASH, CONTRACT_CHUNKS, contractRows, deployChunkRows,
} = require('./recovery_determinism_e2e.test/helpers/recovery_contract_leg');

// Every block below reads the same two nodes, built once by whichever block's before()
// runs first, as the single before() of the one-block suite built them once. So the
// teardown runs once too, from this root hook after the whole run: a per-block after()
// would drop the databases under the blocks still to come, and an after() on the last
// block never runs when a --grep leaves that block out, which would leave the pools
// open and the run hung.
after(teardownRecoveredNodes);

describe('Recovery-determinism e2e (consensus) @integration', function () {
    this.timeout(120000);
    const nodes = useRecoveredNodes();

    it('sanity: both nodes assigned the stake source the same deterministic id', async function () {
        const idA = await nodes.A.getAddressId(STAKE_SOURCE);
        const idB = await nodes.Bbtc.getAddressId(STAKE_SOURCE);
        assert.strictEqual(Number(idB), Number(idA));
        assert.ok(Number(idA) > 0);
    });

    it('(1) index-map checksum is IDENTICAL across the recovery boundary', async function () {
        const a = await indexMapChecksum(nodes.A, COLLECT_BLOCK);
        const b = await indexMapChecksum(nodes.Bbtc, COLLECT_BLOCK);
        assert.strictEqual(b, a, 'recovered node must reproduce the from-genesis index-map checksum');
    });

    it('(2) validator_rewards are byte-identical across the recovery boundary', async function () {
        const rewA = await rewardRows(nodes.A);
        const rewB = await rewardRows(nodes.Bbtc);
        assert.strictEqual(rewA.length, 1, 'node A has exactly the one anchor reward');
        assert.deepStrictEqual(rewB, rewA, 'recovered validator_rewards must match from-genesis row-for-row');
        // And the reward sits under the deterministic source id (not an offset one).
        const idA = String(await nodes.A.getAddressId(STAKE_SOURCE));
        assert.strictEqual(rewA[0].source_id, idA);
        assert.strictEqual(rewA[0].block_index, String(EARN_BLOCK));
    });

    it('(3) COLLECT unclaimed total is equal across the recovery boundary', async function () {
        const totA = await nodes.A.getUnclaimedRewardTotal(STAKE_SOURCE, COLLECT_BLOCK);
        const totB = await nodes.Bbtc.getUnclaimedRewardTotal(STAKE_SOURCE, COLLECT_BLOCK);
        assert.strictEqual(String(totB), String(totA), 'COLLECT must credit the same amount on both nodes');
        assert.ok(util.bcgt(totA, '0'), 'the reward must actually be collectable (> 0)');
    });

});

describe('Recovery-determinism e2e (consensus) @integration', function () {
    this.timeout(120000);
    const nodes = useRecoveredNodes();

    // Armed check: with the index-map class ARMED in state_hash, the recovered node must produce a
    // per-block state_hash byte-identical to the from-genesis node (no false halt), and the
    // class must actually be folded in (armed hash differs from the inert hash). This is the
    // enforcement the advisory checksum is promoted to: a divergent id map would change
    // state_hash and HALT the follower; an identical map (the recovery guarantee) does not.
    it('(4) P4 armed: per-block state_hash is identical A vs B, and the id map is enforced', async function () {
        const opts = (network) => ({ activationDelay: null, gasTick: 'XCHAIN', network });
        const prev = INDEX_MAP_STATE_HASH_ACTIVATION.regtest;
        INDEX_MAP_STATE_HASH_ACTIVATION.regtest = 0;   // arm for this assertion only
        try {
            for (const b of CHAIN) {
                const armedA = util.getDataHash(await buildStateHashData(nodes.A,    b.block, opts('regtest')));
                const armedB = util.getDataHash(await buildStateHashData(nodes.Bbtc, b.block, opts('regtest')));
                assert.strictEqual(armedB, armedA,
                    'block ' + b.block + ': recovered state_hash must match from-genesis (no false halt)');
                // The class is genuinely active: arming changes the hash vs inert (id map is folded in).
                const inertA = util.getDataHash(await buildStateHashData(nodes.A, b.block, opts('mainnet')));   // mainnet placeholder = inert
                assert.notStrictEqual(armedA, inertA,
                    'block ' + b.block + ': armed state_hash must fold in the id map (differ from inert)');
            }
        } finally {
            INDEX_MAP_STATE_HASH_ACTIVATION.regtest = prev;
        }
    });

});

describe('Recovery-determinism e2e (consensus) @integration', function () {
    this.timeout(120000);
    const nodes = useRecoveredNodes();

    // contract-heavy re-confirm on the chunked-DEPLOY launch bundle. The v4-carrier +
    // v2-assembly deploy must reindex byte-identically across the recovery boundary.
    it('(5) chunked-DEPLOY contract is byte-identical A vs B across the recovery boundary', async function () {
        if (!nodes.contractLegRan) return this.skip();
        const cA = await contractRows(nodes.A);
        const cB = await contractRows(nodes.Bbtc);
        assert.strictEqual(cA.length, 1, 'node A deployed exactly the one chunked contract');
        assert.deepStrictEqual(cB, cA, 'recovered node must reproduce the from-genesis contract row-for-row');
        // The stored source is the reassembled plaintext and its declared hash binds it.
        assert.strictEqual(cA[0].code, CONTRACT_CODE, 'assembled code equals the deployed source');
        assert.strictEqual(cA[0].code_hash, CONTRACT_HASH, 'code_hash is sha256 of the assembled source');
        assert.strictEqual(cA[0].status, 'valid');
        // source_id is an index_addresses id: identical only because recovery keeps the id map
        // aligned across the recovery pre-seed. Pin it to the deployer's deterministic id.
        const deployerIdA = String(await nodes.A.getAddressId(CONTRACT_DEPLOYER));
        const deployerIdB = String(await nodes.Bbtc.getAddressId(CONTRACT_DEPLOYER));
        assert.strictEqual(deployerIdB, deployerIdA, 'deployer id is identical across the recovery boundary');
        assert.strictEqual(cA[0].source_id, deployerIdA, 'contract binds the deterministic deployer id');
    });

    it('(6) deploy_chunks carriers are byte-identical A vs B despite different insert order', async function () {
        if (!nodes.contractLegRan) return this.skip();
        const kA = await deployChunkRows(nodes.A);
        const kB = await deployChunkRows(nodes.Bbtc);
        assert.strictEqual(kA.length, CONTRACT_CHUNKS, 'all v4 carriers were stored on node A');
        assert.deepStrictEqual(kB, kA, 'recovered node stores byte-identical carrier rows (order-independent)');
        // The chunk group is bound to the same deployer id and code_hash on both nodes.
        for (const row of kA) {
            assert.strictEqual(row.code_hash, CONTRACT_HASH);
            assert.strictEqual(row.status, 'valid');
        }
    });
});

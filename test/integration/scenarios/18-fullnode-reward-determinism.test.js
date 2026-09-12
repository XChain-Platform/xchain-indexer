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
 * Integration: full-node participation accrual, genesis-reindex determinism, and the
 * PRICE batch's zero-reward rule.
 *
 * RETIRED HERE, AND WHY (the batch collapse). This scenario used to assert a two-tranche
 * oracle reward split: oracle_base for every round signer, plus oracle_full_node for the
 * staking sources that answered at least MIN_PASS_RATE_BPS of the challenge epochs. PRICE
 * version 0 is now the validator BATCH format, and the per-round wire that carried the
 * inline reward derivation was deleted rather than deprecated. The batch derives NO
 * rewards at all, by design: the retired derivation only ever fired for prices landing on
 * Bitcoin (which production never does), and paying the elected publisher alone would
 * misprice every other validator's participation, so a real participation rail is tracked
 * separately. oracle_base and oracle_full_node are consequently unreachable - nothing in
 * src/ can emit either row - so the tranche assertions were removed outright rather than
 * re-pointed at some other action that happens to pay. Re-pointing would have kept a
 * green test that proved nothing about the split it was named for. In their place sits a
 * pin on the ruled behavior: a VALID, BTC-landed batch writes zero validator_rewards
 * rows. Should a future participation rail reintroduce a split, it earns its own scenario.
 *
 * What survives is the half PRICE was only ever the vehicle for, and it is still
 * consensus-critical: every indexer replaying the same chain MUST derive the same
 * participation and the same consensus hashes, or the federation forks. The unit tests
 * cover the batch's zero-reward rule against a mocked DB; the live e2e (multiHubNodeProof)
 * covers NODEPROOF accrual alone. Neither proves these replay byte-identical through the
 * REAL DB pipeline from a genesis reindex - this does.
 *
 * Drives the path end-to-end through the REAL indexer against a real DB:
 *   1. STAKE five validators above full_node MIN_STAKE (2000). V1+V2 share staking
 *      source A1 (so a source with two signers stays one source); V3 from A2, V4 from A3,
 *      V5 from A4. V5 then UNSTAKEs, so its stake deactivates INSIDE the second epoch's
 *      buried snapshot window: still a claimant at the height the hub locked the
 *      claimant set at, gone by the raw epoch and by the verdict block.
 *   2. Two challenge epochs of REAL Ed25519 NODEPROOF verdicts. V1,V2,V3,V5 pass BOTH
 *      epochs; V4 passes only ONE (pass-rate 50% < 70%).
 *      challenge_id = sha256(network:epoch:ledger_hash:target) - re-derived from the
 *      indexer's own stored epoch ledger hash, so the corpus is a deterministic
 *      function of earlier on-chain state (the property under test).
 *   3. A REAL signed PRICE batch that V1-V4 sign and that the indexer accepts as
 *      valid, landing on BTC where the retired derivation would have paid out.
 *   4. Assert (a) the participation the gate reads accrued per SOURCE, not per signer,
 *      (b) an epoch is credited to a staking source that was a claimant at the BURIED
 *      height even though its stake is gone by the raw epoch, (c) the valid batch wrote
 *      zero validator_rewards rows, and (d) the reward rows AND the chained consensus
 *      block hashes are BYTE-IDENTICAL when re-derived from a clean DB (no fork).
 *
 * The FULLNODE_REWARD_SHARE knob below is kept deliberately non-zero: a zero share would
 * make the zero-reward pin vacuous by disabling a split that no longer exists anyway.
 *
 * Mirrors the harness of 10-determinism-baseline / 17-slash-equivocation. Needs a
 * disposable MariaDB (TEST_DB_*) and a Node 22 runtime. Run standalone so the FULLNODE_*
 * env below is read at config-build time:
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=... TEST_DB_USER=... TEST_DB_PASS=... \
 *   npx mocha --no-config --timeout 120000 \
 *     test/integration/scenarios/18-fullnode-reward-determinism.test.js
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer, destroyFileIndexers } = require('../setup/indexer-launcher');
const ed25519 = require('../../../src/ed25519.js');
const eq      = require('../../../src/equivocation_header.js');

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const NETWORK = 'regtest';

// Regtest FULLNODE knobs (read live at config-build time by configs/BTC.js). A short
// cadence so epoch boundaries land inside the seeded corpus; REWARD_SHARE>0 activates the
// two-tranche split. Set in before()/restored in after() (not at module scope) so they
// never leak into sibling scenarios when the whole integration suite runs.
const FULLNODE_ENV = {
    FULLNODE_REWARD_SHARE:                 '0.25',
    FULLNODE_CHALLENGE_INTERVAL_BLOCKS:    '5',
    FULLNODE_CONFIRM_DEPTH:                '2',
    FULLNODE_PROOF_WINDOW_BLOCKS:          '1000',
    FULLNODE_VERDICT_ACCEPT_WINDOW_BLOCKS: '50',
    FULLNODE_REWARD_PASS_WINDOW_BLOCKS:    '1000',
    FULLNODE_MIN_PASS_RATE_BPS:            '7000',   // 70% → 1-of-2 epochs (50%) is excluded
};
const _savedEnv = {};

// Known-good regtest addresses (also used by 10-determinism / 17-slash).
const FUNDER = 'mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ'; // holds the bootstrap supply
const A1     = 'mq7tVfobimRUPxPNnyd5mKn11SVmTiLxtu'; // funds V1 + V2 (shared source)
const A2     = 'n4nbVcRRR5sEHyp2VYuLUvCyDmQmBoonoK'; // funds V3
const A3     = 'mvuKWKvgzrkxh8QgNZ91vMBZUKN5BFYmo3'; // funds V4
const A4     = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD'; // funds V5 (unstakes inside the buried window)
const T = 1700000000;

const STAKE_AMT = '2500.00000000';   // > full_node MIN_STAKE (2000) and > price MIN_STAKE (1000)
// Multiples of CHALLENGE_INTERVAL (5). Both epochs sit far enough above the stake
// activation blocks (106 and 107 = stake block + ACTIVATION_DELAY_BLOCKS) that the
// BURIED heights the attribution resolves at, epoch - CANONICAL_REORG_BUFFER = 114 and
// 119, are past activation too. Epochs at 110/115 would bury to 104/109 and put the
// first epoch BELOW activation, which is a fixture artifact, not a finding: it credits
// nobody for that epoch and every per-source count comes back one short.
const EPOCHS    = [120, 125];
const REORG_BUF = 6;                  // CANONICAL_REORG_BUFFER (snapshot_reorg_buffer.js)
const DEPTH     = 2;                  // FULLNODE_CONFIRM_DEPTH
const STAKE_BLK = 101;                // V5's stake block (activation 107)
const UNSTAKE_BLK = 115;              // V5 unstakes here, so its stake deactivates at 121:
                                      // inside (125 - 6, 125], i.e. active at the buried
                                      // height the hub locked its claimant set at, gone by
                                      // the raw epoch and by the verdict block
const FILL_BLK  = 126;                // trivial tx so the decoder tip clears both epochs
const V120_BLK  = 127, V125_BLK = 128;  // verdict blocks (within VERDICT_ACCEPT_WINDOW of each epoch)
const PRICE_BLK = 130;                // PRICE batch block, and the batch's own BTC anchor
const ROUND     = 1;                  // single-round window, so FIRST_ROUND == LAST_ROUND

// Deterministic Ed25519 identity: { privateKey (KeyObject), pub (raw 64-hex, lowercase) }.
function genKey() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const der = publicKey.export({ format: 'der', type: 'spki' });
    return { privateKey, pub: Buffer.from(der.slice(-32)).toString('hex').toLowerCase() };
}
const signHex = (priv, buf) => crypto.sign(null, buf, priv).toString('hex');

// Build a NODEPROOF v0 wire action for `epoch`, signed by the genesis verifiers, exactly
// as nodeproof.js reconstructs + verifies it. challenge_id binds to the epoch's stored
// ledger hash (passed in), so the corpus is a function of earlier on-chain state.
function buildNodeproofWire(epoch, ledgerHash, passKeys, verifiers) {
    const target      = epoch - DEPTH;
    const preimage    = NETWORK + ':' + epoch + ':' + String(ledgerHash) + ':' + target;
    const challengeId = crypto.createHash('sha256').update(preimage).digest('hex');
    const passSorted  = passKeys.map(p => p.pub.toLowerCase()).sort();

    let canonRaw = challengeId + '|' + epoch + '|' + passSorted.join(',');
    if (eq.isEquivHeaderActive(epoch, NETWORK))
        canonRaw = eq.buildEquivCanonical(eq.ENGINE_TAGS.NODEPROOF, challengeId, 0, canonRaw);
    const canonical = Buffer.from(canonRaw, 'utf8');

    const sigFields = [];
    for (const v of verifiers) { sigFields.push(v.pub, signHex(v.privateKey, canonical)); }

    return ['NODEPROOF', '0', challengeId, String(epoch),
            String(passSorted.length), ...passSorted,
            String(verifiers.length), ...sigFields].join('|');
}

// Build a signed PRICE batch wire action (version 0) carrying a single round body, over
// the canonical buildPriceBatchPayload applies (it wraps the ORACLE_BATCH equiv header
// itself, unconditionally, unlike the retired per-round builder's height gate).
// Wire: PRICE|0|FIRST_ROUND|LAST_ROUND|BTC_BLOCK_HEIGHT|ROUND_COUNT|
//         ROUND|TIMESTAMP|ANCHOR_HEIGHT|PAIR_COUNT|pair|price|...  |SIG_COUNT|PUBKEY|SIG|...
//
// One round is enough: the window bounds collapse to that round and its anchor equals the
// header anchor, which is what the parser requires and what keeps the batch off both
// straddle rules. A wider window would exercise batching, not the reward rule under test.
function buildPriceBatchWire(round, timestamp, pairs, signers, btcHeight) {
    const rounds  = [{ round: round, timestamp: timestamp, btcBlockHeight: btcHeight, pairs: pairs }];
    const payload = Buffer.from(ed25519.buildPriceBatchPayload(round, round, btcHeight, rounds), 'utf8');
    const pairFields = [];
    for (const p of pairs) pairFields.push(p.pair, p.price);
    const sigFields = [];
    for (const s of signers) { sigFields.push(s.pub, signHex(s.privateKey, payload)); }
    return ['PRICE', '0', String(round), String(round), String(btcHeight), '1',
            String(round), String(timestamp), String(btcHeight),
            String(pairs.length), ...pairFields,
            String(signers.length), ...sigFields].join('|');
}

describe('Integration: full-node participation determinism and the batch zero-reward rule @regression @tier1', function () {
    this.timeout(180000);

    let V1, V2, V3, V4, V5, verifiers, firstRun;

    // One clean-DB run: seed gas + stake + (derived) NODEPROOF verdicts + a signed PRICE
    // batch, drive the REAL indexer, and read back the reward rows + consensus hash chain.
    async function runCorpus() {
        await resetDecoderDb();
        await resetIndexerDb();
        const seeder = new DecoderSeeder(decoderQuery);

        // Block 99 - gas bootstrap (issuing/minting the gas tick is fee-exempt).
        await seeder.seedBlock(99, T - 600, [
            { source: FUNDER, data: 'ISSUE|0|XCHAIN|21000000|1000000|8|Gas bootstrap' },
            { source: A1,     data: 'MINT|0|XCHAIN|12000' },
            { source: A2,     data: 'MINT|0|XCHAIN|8000'  },
            { source: A3,     data: 'MINT|0|XCHAIN|8000'  },
            { source: A4,     data: 'MINT|0|XCHAIN|8000'  },
        ]);
        // Blocks 100/101 - stake the five validators (V1+V2 share source A1).
        await seeder.seedBlock(100, T, [
            { source: A1, data: 'STAKE|1|' + STAKE_AMT + '|' + V1.pub },
            { source: A1, data: 'STAKE|1|' + STAKE_AMT + '|' + V2.pub },
        ]);
        await seeder.seedBlock(STAKE_BLK, T + 600, [
            { source: A2, data: 'STAKE|1|' + STAKE_AMT + '|' + V3.pub },
            { source: A3, data: 'STAKE|1|' + STAKE_AMT + '|' + V4.pub },
            { source: A4, data: 'STAKE|1|' + STAKE_AMT + '|' + V5.pub },
        ]);
        // Block 115 - V5 unstakes. The stake rows deactivate at 115 + 6 = 121, which is
        // inside the second epoch's buried window (119, 125]: V5 is a full_node at the
        // height the hub locked its claimant universe at, so the hub challenges it and a
        // quorum attests it, but it holds no active stake at the raw epoch or at the
        // verdict block. Reading either of those heights loses the epoch for source A4.
        await seeder.seedBlock(UNSTAKE_BLK, T + 900, [
            { source: A4, data: 'UNSTAKE|0|' + V5.pub },
        ]);
        // A trivial tx so the decoder tip clears both epochs; the blocks between (incl.
        // the two epoch heights) are processed as empty blocks and each gets a stored
        // ledger hash.
        await seeder.seedBlock(FILL_BLK, T + 1200, [
            { source: A1, destination: A2, data: 'SEND|0|XCHAIN|0.00000001|' + A2 },
        ]);

        const indexer = await initIndexer();
        try {
            // Phase A - process through the filler block so the epoch ledger hashes exist.
            await processBlocks(indexer);

            // Phase B - derive each epoch's challenge from its stored ledger hash, build +
            // sign the NODEPROOF verdicts. V1,V2,V3 pass both epochs; V4 passes only the
            // first (pass rate 50% < 70%); V5 passes both, having unstaked in between.
            const passByEpoch = {
                [EPOCHS[0]]: [V1, V2, V3, V4, V5],
                [EPOCHS[1]]: [V1, V2, V3, V5],
            };
            const verdictBlk  = { [EPOCHS[0]]: V120_BLK, [EPOCHS[1]]: V125_BLK };
            for (const epoch of EPOCHS) {
                const hashes = await indexer.indexerDb.getStoredBlockHashes(epoch);
                assert.ok(hashes && hashes.ledger_hash, 'epoch ' + epoch + ' must have a stored ledger hash');
                const wire = buildNodeproofWire(epoch, hashes.ledger_hash, passByEpoch[epoch], verifiers);
                await seeder.seedBlock(verdictBlk[epoch], T + 1800 + epoch,
                    [{ source: A1, data: wire }]);
            }
            await processBlocks(indexer);   // process the verdict blocks → full_node_verifications

            // Phase C - a signed PRICE batch all four sign. It must land VALID for the
            // zero-reward pin to mean anything: an invalid action pays nothing for the
            // uninteresting reason.
            const priceWire = buildPriceBatchWire(ROUND, T + 3600,
                [{ pair: 'BTC/USD', price: '50000' }], [V1, V2, V3, V4], PRICE_BLK);
            await seeder.seedBlock(PRICE_BLK, T + 3600, [{ source: A1, data: priceWire }]);
            await processBlocks(indexer);

            const chain = await indexerQuery(
                `SELECT b.block_index, t1.hash AS ledger, t2.hash AS actions
                 FROM blocks b
                 LEFT JOIN index_transactions t1 ON t1.id = b.ledger_hash_id
                 LEFT JOIN index_transactions t2 ON t2.id = b.actions_hash_id
                 ORDER BY b.block_index ASC`);
            const rewards = await indexerQuery(
                `SELECT vr.reward_type, ip.pubkey AS pubkey, ia.address AS source,
                        vr.amount, vr.round_reference, vr.block_index
                 FROM validator_rewards vr
                 JOIN index_pubkeys   ip ON ip.id = vr.signing_pubkey_id
                 JOIN index_addresses ia ON ia.id = vr.source_id
                 ORDER BY vr.reward_type, ip.pubkey`);
            // Batch status. round_number carries FIRST_ROUND on a batch row, which for this
            // single-round window is ROUND.
            const priceStatus = await indexerQuery(
                `SELECT validation_status AS status FROM prices
                 WHERE round_number = ? LIMIT 1`, [ROUND]);
            // DISTINCT passing epochs per source - the participation numerator the gate reads.
            const participation = await indexerQuery(
                `SELECT ia.address AS source, COUNT(DISTINCT fv.epoch_height) AS epochs
                 FROM full_node_verifications fv
                 JOIN index_addresses ia ON ia.id = fv.source_id
                 WHERE fv.passed = 1
                 GROUP BY ia.address ORDER BY ia.address`);
            return {
                chain: chain.map(r => ({ block_index: Number(r.block_index), ledger: r.ledger, actions: r.actions })),
                rewards: rewards.map(r => ({
                    reward_type: r.reward_type, pubkey: String(r.pubkey).toLowerCase(),
                    source: String(r.source), amount: String(r.amount),
                    round_reference: Number(r.round_reference), block_index: Number(r.block_index),
                })),
                priceStatus: priceStatus.length ? String(priceStatus[0].status) : null,
                participation: participation.map(r => ({ source: String(r.source), epochs: Number(r.epochs) })),
            };
        } finally {
            await destroyIndexer(indexer);
        }
    }

    before(async function () {
        // One fixed set of keys, reused across BOTH runs (the genesis verifiers can't be
        // random - the indexer's FULLNODE_GENESIS_VERIFIERS must name them). Regenerate
        // until V1<V2 lexically so the per-source representative is deterministically V1.
        do { V1 = genKey(); V2 = genKey(); } while (!(V1.pub < V2.pub));
        V3 = genKey(); V4 = genKey(); V5 = genKey();
        verifiers = [V1, V2, V3];   // genesis verifiers (quorum = floor(2*3/3)+1 = 3)

        // Scope the FULLNODE knobs + genesis verifiers to this suite only.
        const env = Object.assign({}, FULLNODE_ENV,
            { FULLNODE_GENESIS_VERIFIERS: verifiers.map(v => v.pub).join(',') });
        for (const k of Object.keys(env)) { _savedEnv[k] = process.env[k]; process.env[k] = env[k]; }

        await createDatabases(__filename);
        await createDecoderSchema();
        firstRun = await runCorpus();
    });

    after(async function () {
        for (const k of Object.keys(_savedEnv)) {
            if (_savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = _savedEnv[k];
        }
        await destroyFileIndexers(__filename);
        await closeAll();
    });

    it('the batch validated and the challenge participation accrued per SOURCE', function () {
        assert.strictEqual(firstRun.priceStatus, 'valid',
            'the PRICE batch must land VALID, or the zero-reward pin below proves nothing');
        // Per SOURCE, not per signer: A1 funded two validators (V1+V2) and still counts as
        // one source, which is the shape any future participation rail has to read.
        const part = new Map(firstRun.participation.map(p => [p.source, p.epochs]));
        assert.strictEqual(part.get(A1), 2, 'source A1 (V1+V2) passed both epochs');
        assert.strictEqual(part.get(A2), 2, 'source A2 (V3) passed both epochs');
        assert.strictEqual(part.get(A3), 1, 'source A3 (V4) passed only one epoch (50% < 70%)');
    });

    // The attribution height, stated as behaviour. V5 was a full_node at 119, the height
    // the producing hub locks its claimant universe at for epoch 125 (every
    // CapabilitySnapshot read subtracts CANONICAL_REORG_BUFFER), so the hub challenged it
    // and the quorum attested it; its stake then deactivated at 121, before the raw epoch
    // and well before the verdict block. Both attribution reads have to resolve at the
    // buried height for the row to exist: the capability GATE in the handler and the
    // SOURCE resolution in the writer. Resolve either one at the raw epoch or at the
    // verdict block and source A4 comes back with one epoch instead of two, silently, for
    // participation the federation already signed off on.
    it('credits an epoch whose staker unstaked inside the buried snapshot window', function () {
        const part = new Map(firstRun.participation.map(p => [p.source, p.epochs]));
        assert.strictEqual(EPOCHS[1] - REORG_BUF, 119,
            'the buried height this case turns on must be what the fixture assumes');
        assert.strictEqual(part.get(A4), 2,
            'source A4 (V5) was a claimant at the buried height for BOTH epochs and must be credited for both');
        // And the row is booked to the staking source, not dropped to some other address
        // or left sourceless: A4 appears exactly once in the per-source rollup.
        assert.strictEqual(firstRun.participation.filter(p => p.source === A4).length, 1,
            'V5 participation must roll up under its own staking source');
    });

    it('a VALID BTC-landed PRICE batch writes ZERO validator_rewards rows', function () {
        // The ruled behavior after the batch collapse. Every condition the retired per-round
        // derivation needed is satisfied here and it still must not pay: the action is valid,
        // it landed on BTC (the only chain that derivation ever fired on), four capable
        // validators signed it, FULLNODE_REWARD_SHARE is non-zero, and real challenge
        // participation exists in the DB for it to have read. Nothing pays it because the
        // derivation is gone, not because the setup fell short.
        // The retired tranche types first, so a reintroduced split reports as itself rather
        // than as a generic non-empty table.
        assert.deepStrictEqual(firstRun.rewards.filter(r => r.reward_type === 'oracle_base' ||
                                                           r.reward_type === 'oracle_full_node'), [],
            'the oracle tranche reward types are unreachable and must stay unreachable');
        // Catch-all: no reward of ANY type is derived from a batch, so a new type added later
        // cannot start paying here unnoticed.
        assert.deepStrictEqual(firstRun.rewards, [],
            'the validator batch derives no rewards; a non-empty table means a derivation came back');
    });

    it('re-deriving from a clean DB yields IDENTICAL reward rows + hash chain (determinism = no fork)', async function () {
        const second = await runCorpus();
        assert.deepStrictEqual(second.rewards, firstRun.rewards,
            'reward rows differ for the same input - fork risk');
        // The load-bearing one now that the reward table is empty: the hash chain covers
        // the whole corpus, batch and verdicts included, so a divergence anywhere in block
        // processing surfaces here.
        assert.deepStrictEqual(second.chain, firstRun.chain,
            'block processing produced different consensus hashes for the same input - fork risk');
        assert.deepStrictEqual(second.participation, firstRun.participation,
            'challenge participation replayed differently from a clean DB - fork risk');
    });
});

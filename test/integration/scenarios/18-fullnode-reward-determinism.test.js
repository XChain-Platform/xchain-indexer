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
 * Integration: full-node REWARD-tranche cross-node determinism (reward-only tier).
 *
 * The verified-full-node tier is REWARD-ONLY (no slashing). A staking source earns
 * the oracle-round full-node tranche only if, over the trailing
 * REWARD_PASS_WINDOW_BLOCKS, it answered at least MIN_PASS_RATE_BPS of the challenge
 * epochs that produced a verdict (db.getFullNodeParticipation → price.js). That gate
 * is consensus-critical: every indexer that replays the same chain MUST derive the
 * SAME validator_rewards rows, or the federation forks. The unit tests pin the split
 * with a mocked DB; the live e2e (multiHubNodeProof) proves only the NODEPROOF
 * participation accrual and intentionally skips a real PRICE oracle round. Neither
 * proves the reward ROWS replay byte-identical through the REAL DB pipeline from a
 * genesis reindex - this does.
 *
 * Drives the whole reward path end-to-end through the REAL indexer against a real DB:
 *   1. STAKE four validators above full_node MIN_STAKE (2000). V1+V2 share staking
 *      source A1 (exercises the per-source dedup → one tranche share per source); V3
 *      from A2, V4 from A3.
 *   2. Two challenge epochs of REAL Ed25519 NODEPROOF verdicts. V1,V2,V3 pass BOTH
 *      epochs; V4 passes only ONE (→ pass-rate 50% < 70%, excluded from the tranche).
 *      challenge_id = sha256(network:epoch:ledger_hash:target) - re-derived from the
 *      indexer's own stored epoch ledger hash, so the corpus is a deterministic
 *      function of earlier on-chain state (the property under test).
 *   3. A REAL signed PRICE v0 round (REWARD_SHARE=0.25) that all four sign → the
 *      indexer writes the two-tranche split: oracle_base (all signers) + oracle_full_node
 *      (qualifying sources only, deduped to the lex-smallest passing signer per source).
 *   4. Assert (a) the validator_rewards rows AND the chained consensus block hashes are
 *      BYTE-IDENTICAL when re-derived from a clean DB (determinism = no fork), and
 *      (b) the structural shape: 4 base rows, 2 full-node rows (V4's low-rate source
 *      excluded), source-deduped representative = lex-smallest passing signer.
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
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
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
const T = 1700000000;

const STAKE_AMT = '2500.00000000';   // > full_node MIN_STAKE (2000) and > price MIN_STAKE (1000)
const EPOCHS    = [110, 115];         // multiples of CHALLENGE_INTERVAL (5), past activation (107)
const DEPTH     = 2;                  // FULLNODE_CONFIRM_DEPTH
const V110_BLK  = 117, V115_BLK = 118;  // verdict blocks (within VERDICT_ACCEPT_WINDOW of each epoch)
const PRICE_BLK = 120;                // PRICE round block (reward derivation reads participation here)
const ROUND     = 1;

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

// Build a signed PRICE v0 wire action over the canonical payload (ed25519.buildPriceV0Payload
// applies the regtest ORACLE equiv header itself, gated on btcHeight per #4232).
// Wire: PRICE|0|ROUND|TIMESTAMP|BTC_BLOCK_HEIGHT|PAIR_COUNT|...|SIG_COUNT|...
function buildPriceWire(round, timestamp, pairs, signers, btcHeight) {
    const payload = Buffer.from(ed25519.buildPriceV0Payload(round, timestamp, pairs, NETWORK, btcHeight), 'utf8');
    const pairFields = [];
    for (const p of pairs) pairFields.push(p.pair, p.price);
    const sigFields = [];
    for (const s of signers) { sigFields.push(s.pub, signHex(s.privateKey, payload)); }
    return ['PRICE', '0', String(round), String(timestamp), String(btcHeight),
            String(pairs.length), ...pairFields,
            String(signers.length), ...sigFields].join('|');
}

describe('Integration: full-node reward-tranche determinism @regression @tier1', function () {
    this.timeout(180000);

    let V1, V2, V3, V4, verifiers, firstRun;

    // One clean-DB run: seed gas + stake + (derived) NODEPROOF verdicts + a signed PRICE
    // round, drive the REAL indexer, and read back the reward rows + consensus hash chain.
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
        ]);
        // Blocks 100/101 - stake the four validators (V1+V2 share source A1).
        await seeder.seedBlock(100, T, [
            { source: A1, data: 'STAKE|1|' + STAKE_AMT + '|' + V1.pub },
            { source: A1, data: 'STAKE|1|' + STAKE_AMT + '|' + V2.pub },
        ]);
        await seeder.seedBlock(101, T + 600, [
            { source: A2, data: 'STAKE|1|' + STAKE_AMT + '|' + V3.pub },
            { source: A3, data: 'STAKE|1|' + STAKE_AMT + '|' + V4.pub },
        ]);
        // Block 116 - a trivial tx so the decoder tip ≥ 116; blocks 102–115 (incl. the two
        // epoch heights) are processed as empty blocks and each gets a stored ledger hash.
        await seeder.seedBlock(116, T + 1200, [
            { source: A1, destination: A2, data: 'SEND|0|XCHAIN|0.00000001|' + A2 },
        ]);

        const indexer = await initIndexer();
        try {
            // Phase A - process through 116 so the epoch ledger hashes exist.
            await processBlocks(indexer);

            // Phase B - derive each epoch's challenge from its stored ledger hash, build +
            // sign the NODEPROOF verdicts. V1,V2,V3 pass both epochs; V4 passes only 110.
            const passByEpoch = { 110: [V1, V2, V3, V4], 115: [V1, V2, V3] };
            const verdictBlk  = { 110: V110_BLK, 115: V115_BLK };
            for (const epoch of EPOCHS) {
                const hashes = await indexer.indexerDb.getStoredBlockHashes(epoch);
                assert.ok(hashes && hashes.ledger_hash, 'epoch ' + epoch + ' must have a stored ledger hash');
                const wire = buildNodeproofWire(epoch, hashes.ledger_hash, passByEpoch[epoch], verifiers);
                await seeder.seedBlock(verdictBlk[epoch], T + 1800 + epoch,
                    [{ source: A1, data: wire }]);
            }
            await processBlocks(indexer);   // process the verdict blocks → full_node_verifications

            // Phase C - a signed PRICE v0 round; the indexer derives the two-tranche reward split.
            const priceWire = buildPriceWire(ROUND, T + 3600,
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
            // PRICE round status (sanity - the reward path only runs on a VALID round).
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
        V3 = genKey(); V4 = genKey();
        verifiers = [V1, V2, V3];   // genesis verifiers (quorum = floor(2*3/3)+1 = 3)

        // Scope the FULLNODE knobs + genesis verifiers to this suite only.
        const env = Object.assign({}, FULLNODE_ENV,
            { FULLNODE_GENESIS_VERIFIERS: verifiers.map(v => v.pub).join(',') });
        for (const k of Object.keys(env)) { _savedEnv[k] = process.env[k]; process.env[k] = env[k]; }

        await createDatabases();
        await createDecoderSchema();
        firstRun = await runCorpus();
    });

    after(async function () {
        for (const k of Object.keys(_savedEnv)) {
            if (_savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = _savedEnv[k];
        }
        await closeAll();
    });

    it('the PRICE round validated and produced the participation the gate expects (sanity)', function () {
        assert.strictEqual(firstRun.priceStatus, 'valid', 'PRICE v0 round must validate for rewards to fire');
        const part = new Map(firstRun.participation.map(p => [p.source, p.epochs]));
        assert.strictEqual(part.get(A1), 2, 'source A1 (V1+V2) passed both epochs');
        assert.strictEqual(part.get(A2), 2, 'source A2 (V3) passed both epochs');
        assert.strictEqual(part.get(A3), 1, 'source A3 (V4) passed only one epoch (50% < 70%)');
    });

    it('writes the two-tranche split: base = every signer, full-node = qualifying sources only', function () {
        const base = firstRun.rewards.filter(r => r.reward_type === 'oracle_base');
        const full = firstRun.rewards.filter(r => r.reward_type === 'oracle_full_node');

        // Base tranche - one row per qualified signer (all four).
        assert.strictEqual(base.length, 4, 'one oracle_base row per signer');
        assert.deepStrictEqual(new Set(base.map(r => r.pubkey)),
            new Set([V1, V2, V3, V4].map(v => v.pub)), 'base tranche covers every signer');
        assert.ok(base.every(r => r.amount === base[0].amount), 'base split is equal');
        assert.notStrictEqual(Number(base[0].amount), 0, 'base reward is non-zero');

        // Full-node tranche - one row per QUALIFYING source (A1, A2). A3 (V4, 50% < 70%)
        // is excluded; A1 is deduped to its lex-smallest passing signer (V1).
        assert.strictEqual(full.length, 2, 'one oracle_full_node row per qualifying source');
        assert.deepStrictEqual(new Set(full.map(r => r.pubkey)), new Set([V1.pub, V3.pub]),
            'full-node tranche = lex-smallest passing signer of each qualifying source (A1→V1, A2→V3)');
        assert.ok(!full.some(r => r.pubkey === V4.pub),
            'V4 (source A3, below the 70% pass-rate) must NOT earn the full-node tranche');
        assert.ok(full.every(r => r.amount === full[0].amount), 'full-node split is equal');
        assert.notStrictEqual(Number(full[0].amount), 0, 'full-node reward is non-zero');
    });

    it('re-deriving from a clean DB yields IDENTICAL reward rows + hash chain (determinism = no fork)', async function () {
        const second = await runCorpus();
        assert.deepStrictEqual(second.rewards, firstRun.rewards,
            'reward derivation produced different validator_rewards rows for the same input - fork risk');
        assert.deepStrictEqual(second.chain, firstRun.chain,
            'reward processing produced different consensus hashes for the same input - fork risk');
        assert.deepStrictEqual(second.participation, firstRun.participation);
    });
});

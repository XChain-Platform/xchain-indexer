// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Price   = require('../../../src/actions/price.js');
// Same cached modules Price references - stubbing verify() controls sig acceptance,
// stubbing isStakeWeightedQuorumActive() selects the count vs stake-weighted path.
const ed25519 = require('../../../src/ed25519.js');
const swq     = require('../../../src/stake_weighted_quorum.js');

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);
const PUBKEY_C = 'c'.repeat(64);
const SIG_A    = '1'.repeat(128);
const SIG_B    = '2'.repeat(128);
const SIG_C    = '3'.repeat(128);

// Every pubkey this suite signs with (the byte-repeat forms cover the Sybil
// fixtures below). The mock DB resolves the BATCHED capability set over this
// universe, mirroring db.js where getValidatorsByCapability and hasCapability
// answer from the same _effectiveCapabilitySetSql (#3871).
const ALL_PUBKEYS = Array.from(new Set(
    [PUBKEY_A, PUBKEY_B, PUBKEY_C].concat(
        Array.from({ length: 16 }, (_, i) => i.toString(16).padStart(2, '0').repeat(32)))));

describe('Price (PRICE) @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    function addPriceDbStubs(db) {
        db.createPrice                  = sinon.stub().resolves();
        db.hasCapability                = sinon.stub();
        db.getValidatorsByCapability    = sinon.stub();
        db.getActiveCapabilityCount     = sinon.stub().resolves(1);
        db.getStakeWeightsByCapability  = sinon.stub().resolves([]);
        db.createValidatorReward        = sinon.stub().resolves(true);
        setCapable(db, () => true);
    }

    // Drive BOTH capability APIs from one predicate, the way db.js does (#3871):
    // a case that says who qualifies stays honest whichever path the handler takes.
    function setCapable(db, predicate) {
        db.hasCapability.callsFake(async (pubkey, cap, blk) => !!(await predicate(pubkey, cap, blk)));
        db.getValidatorsByCapability.callsFake(async (cap, blk) => {
            const rows = [];
            for (const pubkey of ALL_PUBKEYS)
                if (await predicate(pubkey, cap, blk)) rows.push({ pubkey, amount: '0' });
            rows.truncated = false;
            return rows;
        });
    }

    beforeEach(function () {
        indexer = createMockIndexer();
        addPriceDbStubs(indexer.indexerDb);

        actionsCtx = {
            config:    indexer.config,
            util:      indexer.util,
            mapper:    indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            hubClient: null,
        };
        handler = new Price(actionsCtx);
        indexer.util.resetLists();
    });

    afterEach(function () {
        sinon.restore();
    });

    describe('v0 - validator snapshot', function () {

        // PRICE|0|ROUND|TIMESTAMP|BTC_BLOCK_HEIGHT|PAIR_COUNT|PAIR_ID|PAIR_PRICE|...|SIG_COUNT|PUBKEY|SIG|...
        // BTC_BLOCK_HEIGHT (#4232): the round's BTC anchor, in the signed payload and the EQUIV gate input.
        function v0Params(pairs, sigs, overrides = {}) {
            const p = { round: '7', timestamp: '1700000000', btcHeight: '799000', ...overrides };
            const out = ['0', p.round, p.timestamp, p.btcHeight, String(pairs.length)];
            for (const pr of pairs) { out.push(pr.pair, pr.price); }
            out.push(String(sigs.length));
            for (const s of sigs) { out.push(s.pubkey, s.sig); }
            return out;
        }
        function v0Data(overrides = {}) {
            return createBaseData({ ACTION: 'PRICE', FORMAT: 0, BLOCK_INDEX: 100, ...overrides });
        }
        const ONE_PAIR = [{ pair: 'BTC/USD', price: '50000' }];

        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
            // These cases exercise the legacy COUNT quorum (the live path on mainnet
            // below the activation height). Weighted mode has its own describe below.
            sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        });

        it('valid single-validator snapshot (quorum 1) → valid', async function () {
            indexer.indexerDb.getActiveCapabilityCount.resolves(1);
            const data = v0Data();
            await handler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createPrice.calledOnce);
        });

        it('meets PBFT quorum at exactly 2f+1 → valid', async function () {
            // 4 price-capable validators → quorum = 2*floor((4-1)/3)+1 = 3
            indexer.indexerDb.getActiveCapabilityCount.resolves(4);
            const data = v0Data();
            await handler.parse(v0Params(ONE_PAIR, [
                { pubkey: PUBKEY_A, sig: SIG_A },
                { pubkey: PUBKEY_B, sig: SIG_B },
                { pubkey: PUBKEY_C, sig: SIG_C },
            ]), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
        });

        it('fails PBFT quorum at 2f (one below threshold) → invalid', async function () {
            // 4 validators → quorum = 3; only 2 valid sigs
            indexer.indexerDb.getActiveCapabilityCount.resolves(4);
            const data = v0Data();
            await handler.parse(v0Params(ONE_PAIR, [
                { pubkey: PUBKEY_A, sig: SIG_A },
                { pubkey: PUBKEY_B, sig: SIG_B },
            ]), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(String(data['STATUS']).includes('quorum'));
        });

        it('does NOT count duplicate-pubkey signatures twice toward quorum', async function () {
            indexer.indexerDb.getActiveCapabilityCount.resolves(4); // quorum 3
            const data = v0Data();
            // three sigs but two share PUBKEY_A → only 2 distinct → below quorum 3
            await handler.parse(v0Params(ONE_PAIR, [
                { pubkey: PUBKEY_A, sig: SIG_A },
                { pubkey: PUBKEY_A, sig: SIG_B },
                { pubkey: PUBKEY_B, sig: SIG_B },
            ]), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(String(data['STATUS']).includes('quorum'));
        });

        it('counts a signature only when ed25519.verify passes', async function () {
            ed25519.verify.returns(false);
            indexer.indexerDb.getActiveCapabilityCount.resolves(1); // quorum 1
            const data = v0Data();
            await handler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
        });

        it('skips a signer without the price capability at this block', async function () {
            setCapable(indexer.indexerDb, () => false);
            indexer.indexerDb.getActiveCapabilityCount.resolves(1);
            const data = v0Data();
            await handler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
        });

        it('gates stake-weighted quorum on the round BTC anchor (BTC_BLOCK_HEIGHT), not the local BLOCK_INDEX (#2268)', async function () {
            // The local landing height and the round's signed BTC anchor deliberately differ,
            // as they do on LTC/DOGE where the local height (~2.9M/~5.7M) dwarfs the BTC anchor.
            // The activation gate must key on the BTC anchor so every chain and the hub flip on
            // the same height; keying on BLOCK_INDEX made the comparison vacuously true off-BTC
            // and armed stake-weighting there months before the BTC anchor (961000). The anchor
            // is bound in the signed payload (buildPriceV0Payload), so it cannot be forged.
            indexer.indexerDb.getActiveCapabilityCount.resolves(1);
            const data = v0Data({ BLOCK_INDEX: 5700000 });   // a DOGE-like local landing height
            await handler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }], { btcHeight: '799000' }), data, null);
            assert.ok(swq.isStakeWeightedQuorumActive.calledOnce);
            assert.strictEqual(swq.isStakeWeightedQuorumActive.getCall(0).args[0], 799000,
                'gate must receive the round BTC anchor (799000), not the local BLOCK_INDEX (5700000)');
        });

        // . The tally keeps at most one signature per pubkey. WHERE the pubkey
        // enters the dedupe set is consensus: marking on first encounter (the legacy
        // ordering) lets a garbage signature carrying a qualified oracle's pubkey,
        // placed AHEAD of that oracle's real one, consume the slot, so the real
        // signature is skipped as a duplicate and a legitimately quorate round is
        // rejected on chain. Anyone who sees a round before broadcast can mint that
        // list; the sigs are public. Gated because PRICE is genesis-active on mainnet
        // with live history, so below the gate the legacy ordering must survive
        // verbatim or a from-genesis reindex diverges.
        describe('signature-tally ordering flag-day ', function () {

            const BAD_SIG = '9'.repeat(128);

            beforeEach(function () {
                // Only BAD_SIG fails to verify; every other signature is good.
                ed25519.verify.callsFake((payload, sig) => sig !== BAD_SIG);
            });

            it('at/above the gate: a garbage sig ordered AHEAD of the same signer\'s valid one still tallies', async function () {
                indexer.indexerDb.getActiveCapabilityCount.resolves(1); // quorum 1
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: BAD_SIG },   // garbage, first on the wire
                    { pubkey: PUBKEY_A, sig: SIG_A },     // the oracle's real signature
                ]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid',
                    'the real signature must not be skipped as a duplicate of a signature that never verified');
            });

            it('at/above the gate: ordering does not change the verdict (valid-first is still valid)', async function () {
                indexer.indexerDb.getActiveCapabilityCount.resolves(1);
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: SIG_A },
                    { pubkey: PUBKEY_A, sig: BAD_SIG },
                ]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
            });

            it('at/above the gate: a signer with ONLY garbage entries still does not count', async function () {
                indexer.indexerDb.getActiveCapabilityCount.resolves(1); // quorum 1
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: BAD_SIG },
                    { pubkey: PUBKEY_A, sig: BAD_SIG },
                ]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid',
                    'verify-then-mark must not become "retry until something passes"');
            });

            it('at/above the gate: a repeated VALID signer still counts exactly once', async function () {
                // 4 validators -> quorum 3. Two distinct signers, one of them repeated
                // three times: if the repeat inflated the tally this would pass.
                indexer.indexerDb.getActiveCapabilityCount.resolves(4);
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: SIG_A },
                    { pubkey: PUBKEY_A, sig: SIG_B },
                    { pubkey: PUBKEY_A, sig: SIG_C },
                    { pubkey: PUBKEY_B, sig: SIG_B },
                ]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
                assert.ok(String(data['STATUS']).includes('2/3'),
                    'expected a 2-of-3 quorum failure, got: ' + data['STATUS']);
            });

            it('at/above the gate: ONE batched capability read per round, none per signer', async function () {
                // Verify-first no longer short-circuits a repeated pubkey, so a padded
                // list used to issue one ~5-query hasCapability read per distinct signer
                // in the per-tx consensus path (#3871). The set is now resolved once.
                indexer.indexerDb.getActiveCapabilityCount.resolves(1);
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: BAD_SIG },
                    { pubkey: PUBKEY_B, sig: BAD_SIG },
                    { pubkey: PUBKEY_A, sig: SIG_A },
                ]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
                assert.ok(indexer.indexerDb.getValidatorsByCapability
                    .calledWith('price', data['BLOCK_INDEX']));
                assert.strictEqual(indexer.indexerDb.getValidatorsByCapability.callCount, 1);
                assert.strictEqual(
                    indexer.indexerDb.hasCapability.getCalls().filter(c => c.args[1] === 'price').length, 0,
                    'the batched set must serve every signer - no per-signer price read');
            });

            it('a TRUNCATED capability read falls back per-signer rather than dropping a qualified signer', async function () {
                // getValidatorsByCapability caps at VALIDATOR_QUERY_LIMIT and hasCapability
                // does not, so a capped read must never be read as "not qualified": that
                // would under-count the round's quorum (#3871).
                indexer.indexerDb.getActiveCapabilityCount.resolves(1);
                const capped = [];
                capped.truncated = true;
                indexer.indexerDb.getValidatorsByCapability.resolves(capped);
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
                assert.ok(indexer.indexerDb.hasCapability.calledWith(PUBKEY_A, 'price', data['BLOCK_INDEX']));
            });

            it('below the gate: the legacy mark-then-verify verdict is preserved verbatim', async function () {
                // The whole point of gating. mainnet arms at 963000; a round anchored
                // below it must still be rejected exactly as the deployed fleet rejects
                // it today, or a from-genesis reindex diverges from the agreed chain.
                indexer.config['NETWORK'] = 'mainnet';
                indexer.indexerDb.getActiveCapabilityCount.resolves(1); // quorum 1
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: BAD_SIG },
                    { pubkey: PUBKEY_A, sig: SIG_A },
                ], { btcHeight: '962999' }), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid',
                    'below the flag-day the garbage entry must still consume the dedupe slot');
            });

            it('flips on the round BTC anchor, so mainnet at 963000 takes the corrected tally', async function () {
                indexer.config['NETWORK'] = 'mainnet';
                indexer.indexerDb.getActiveCapabilityCount.resolves(1);
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: BAD_SIG },
                    { pubkey: PUBKEY_A, sig: SIG_A },
                ], { btcHeight: '963000' }), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
            });

            it('keys on the BTC anchor, NOT the local BLOCK_INDEX (a DOGE-height round is still below the mainnet gate)', async function () {
                // Same trap #2268 caught for stake-weighted quorum: a DOGE local height
                // (~5.7M) dwarfs the BTC anchor, so a BLOCK_INDEX-keyed gate would read
                // as active on DOGE months before BTC and split the fleet on one round.
                indexer.config['NETWORK'] = 'mainnet';
                indexer.indexerDb.getActiveCapabilityCount.resolves(1);
                const data = v0Data({ BLOCK_INDEX: 5700000 });
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: BAD_SIG },
                    { pubkey: PUBKEY_A, sig: SIG_A },
                ], { btcHeight: '962999' }), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            });

            it('at/above the gate: the reward split follows the widened signer set', async function () {
                // The tally change is monotone, so it moves reward rows as well as the
                // accept/reject verdict; that is the second reason it cannot ship ungated.
                indexer.indexerDb.getActiveCapabilityCount.resolves(1); // quorum 1
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: BAD_SIG },   // A's slot-stealing garbage
                    { pubkey: PUBKEY_A, sig: SIG_A },
                    { pubkey: PUBKEY_B, sig: SIG_B },
                ]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
                const paid = indexer.indexerDb.createValidatorReward.getCalls().map(c => c.args[0]);
                assert.deepStrictEqual(paid.slice().sort(), [PUBKEY_A, PUBKEY_B].sort(),
                    'both signers earn a share; under the legacy ordering A would be dropped');
            });
        });

        it('rejects a malformed pair string', async function () {
            const data = v0Data();
            await handler.parse(v0Params([{ pair: 'not-a-pair', price: '1' }], [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
        });

        it('rejects a malformed SIG_COUNT', async function () {
            const data = v0Data();
            // hand-craft: SIG_COUNT non-numeric (PRICE|0|ROUND|TIMESTAMP|BTC_BLOCK_HEIGHT|PAIR_COUNT|...)
            const params = ['0', '7', '1700000000', '799000', '1', 'BTC/USD', '50000', 'NaN', PUBKEY_A, SIG_A];
            await handler.parse(params, data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
        });

        describe('round rewards derived from the signer set', function () {

            it('valid PRICE → equal floor split to every verified signer, upserted', async function () {
                indexer.indexerDb.getActiveCapabilityCount.resolves(3); // quorum 2... 2*0+1=1, majority 2 → 2
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: SIG_A },
                    { pubkey: PUBKEY_B, sig: SIG_B },
                    { pubkey: PUBKEY_C, sig: SIG_C },
                ]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
                assert.strictEqual(indexer.indexerDb.createValidatorReward.callCount, 3);
                // 10 XCHAIN default / 3 signers, floored to 8dp
                for (const pk of [PUBKEY_A, PUBKEY_B, PUBKEY_C]) {
                    const call = indexer.indexerDb.createValidatorReward.getCalls()
                        .find(c => c.args[0] === pk);
                    assert.ok(call, 'reward for ' + pk.substring(0, 8));
                    assert.strictEqual(call.args[1], 7);                    // ROUND
                    assert.strictEqual(call.args[2], 'oracle_round');
                    assert.strictEqual(String(call.args[3]), '3.33333333'); // floor(10/3, 8dp)
                    assert.strictEqual(call.args[4], data['BLOCK_INDEX']);
                    assert.strictEqual(call.args[5], true);                 // upsert - deterministic writer wins
                }
            });

            it('invalid PRICE (quorum failure) → no rewards', async function () {
                indexer.indexerDb.getActiveCapabilityCount.resolves(4); // quorum 3, only 1 sig
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
                assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
            });

            it('non-BTC chain → no rewards even if validation passes', async function () {
                const data = v0Data({ COIN: 'LTC' });
                await handler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
                assert.ok(indexer.indexerDb.createValidatorReward.notCalled);
            });

            it('duplicate-pubkey signatures earn one share, unqualified signers earn none', async function () {
                indexer.indexerDb.getActiveCapabilityCount.resolves(1); // quorum 1
                // PUBKEY_B lacks the capability; PUBKEY_A appears twice
                setCapable(indexer.indexerDb, (pk) => pk !== PUBKEY_B);
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: SIG_A },
                    { pubkey: PUBKEY_A, sig: SIG_B },
                    { pubkey: PUBKEY_B, sig: SIG_B },
                ]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
                assert.strictEqual(indexer.indexerDb.createValidatorReward.callCount, 1);
                const call = indexer.indexerDb.createValidatorReward.getCall(0);
                assert.strictEqual(call.args[0], PUBKEY_A);
                // bcmulfloor returns un-padded whole numbers ('10' not '10.00000000') - compare numerically
                assert.strictEqual(Number(call.args[3]), 10); // sole qualified signer takes the round
            });
        });

            // With FULLNODE.REWARD_SHARE > 0 the round budget splits into a base
        // tranche (every signer) and a full-node tranche (sources whose trailing
        // pass rate >= MIN_PASS_RATE_BPS, deduped per staking source - a carrot, no
        // slashing). share == 0 keeps the legacy single pot.
        describe('two-tranche full-node split', function () {
            const SA = { pubkey: PUBKEY_A, source: 'addrA', source_id: 1 };
            const SB = { pubkey: PUBKEY_B, source: 'addrB', source_id: 2 };

            function rewardsByType(type) {
                return indexer.indexerDb.createValidatorReward.getCalls().filter(c => c.args[2] === type);
            }
            // Only PASS pubkeys in `fullNodeSet` hold the full_node capability; every
            // signer still holds `price`.
            function fullNodeCapability(set) {
                setCapable(indexer.indexerDb, (pk, cap) => cap !== 'full_node' ? true : set.has(pk));
            }
            // Build a getFullNodeParticipation result from verified-source rows. Each
            // listed source is treated as having passed `passed` of `total` challenge
            // epochs (default: all → 100% pass rate, comfortably above the gate).
            function participation(rows, total = 7, passed = 7) {
                const bySrc = new Map();
                for (const r of rows) {
                    const sid = String(r.source_id);
                    if (!bySrc.has(sid)) bySrc.set(sid, { source_id: r.source_id, source: r.source, passed_epochs: passed, pubkeys: new Set() });
                    bySrc.get(sid).pubkeys.add(String(r.pubkey).toLowerCase());
                }
                return { totalEpochs: total, sources: Array.from(bySrc.values()) };
            }

            beforeEach(function () {
                indexer.config.FULLNODE = Object.assign({}, indexer.config.FULLNODE, { REWARD_SHARE: '0.25' });
                indexer.indexerDb.getFullNodeParticipation = sinon.stub().resolves({ totalEpochs: 0, sources: [] });
                indexer.indexerDb.getActiveCapabilityCount.resolves(3); // quorum 2
            });

            afterEach(function () {
                indexer.config.FULLNODE = Object.assign({}, indexer.config.FULLNODE, { REWARD_SHARE: '0' });
            });

            it('splits base (all signers) + full-node (sufficient pass-rate, per source) tranches', async function () {
                // A and B passed enough challenges (distinct sources); C did not.
                indexer.indexerDb.getFullNodeParticipation.resolves(participation([SA, SB]));
                fullNodeCapability(new Set([PUBKEY_A, PUBKEY_B]));
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: SIG_A },
                    { pubkey: PUBKEY_B, sig: SIG_B },
                    { pubkey: PUBKEY_C, sig: SIG_C },
                ]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid');

                // base: 7.5 / 3 = 2.5 each, to ALL three signers
                const base = rewardsByType('oracle_base');
                assert.strictEqual(base.length, 3);
                for (const c of base) assert.strictEqual(Number(c.args[3]), 2.5);
                // full-node: 2.5 / 2 = 1.25 each, to A and B only
                const full = rewardsByType('oracle_full_node');
                assert.strictEqual(full.length, 2);
                for (const c of full) assert.strictEqual(Number(c.args[3]), 1.25);
                const fullPubs = full.map(c => c.args[0]).sort();
                assert.deepStrictEqual(fullPubs, [PUBKEY_A, PUBKEY_B].sort());
                // no legacy rows in two-tranche mode
                assert.strictEqual(rewardsByType('oracle_round').length, 0);
            });

            it('rolls the full-node tranche into base when no source meets the pass rate', async function () {
                indexer.indexerDb.getFullNodeParticipation.resolves({ totalEpochs: 0, sources: [] }); // no challenges / nobody qualified
                fullNodeCapability(new Set());
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: SIG_A },
                    { pubkey: PUBKEY_B, sig: SIG_B },
                    { pubkey: PUBKEY_C, sig: SIG_C },
                ]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
                // whole 10 → base, 10/3 floored to 8dp; no full-node rows
                const base = rewardsByType('oracle_base');
                assert.strictEqual(base.length, 3);
                for (const c of base) assert.strictEqual(Number(c.args[3]), 3.33333333);
                assert.strictEqual(rewardsByType('oracle_full_node').length, 0);
            });

            it('excludes a source below MIN_PASS_RATE_BPS (missed too many checks)', async function () {
                // 7 epochs ran; A passed 5 (5/7 ≈ 71% ≥ 70% → earns), B passed 4
                // (4/7 ≈ 57% < 70% → excluded). Integer gate: passed*10000 ≥ bps*total.
                indexer.config.FULLNODE = Object.assign({}, indexer.config.FULLNODE, { REWARD_SHARE: '0.25', MIN_PASS_RATE_BPS: 7000 });
                indexer.indexerDb.getFullNodeParticipation.resolves({
                    totalEpochs: 7,
                    sources: [
                        { source_id: 1, source: 'addrA', passed_epochs: 5, pubkeys: new Set([PUBKEY_A]) },
                        { source_id: 2, source: 'addrB', passed_epochs: 4, pubkeys: new Set([PUBKEY_B]) },
                    ],
                });
                fullNodeCapability(new Set([PUBKEY_A, PUBKEY_B]));
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: SIG_A },
                    { pubkey: PUBKEY_B, sig: SIG_B },
                    { pubkey: PUBKEY_C, sig: SIG_C },
                ]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
                const full = rewardsByType('oracle_full_node');
                assert.strictEqual(full.length, 1, 'only the ≥70% source earns');
                assert.strictEqual(full[0].args[0], PUBKEY_A);
                assert.strictEqual(Number(full[0].args[3]), 2.5); // whole 2.5 tranche to the one qualifier
            });

            it('gives one full-node share per SOURCE (delegated keys do not multi-claim)', async function () {
                // A and B passed but share one staking source → one full-node share,
                // credited to the lexicographically smallest pubkey (A).
                indexer.indexerDb.getFullNodeParticipation.resolves(participation([
                    { pubkey: PUBKEY_A, source: 'addrShared', source_id: 1 },
                    { pubkey: PUBKEY_B, source: 'addrShared', source_id: 1 },
                ]));
                fullNodeCapability(new Set([PUBKEY_A, PUBKEY_B]));
                indexer.indexerDb.getActiveCapabilityCount.resolves(1); // quorum 1
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: SIG_A },
                    { pubkey: PUBKEY_B, sig: SIG_B },
                ]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
                const full = rewardsByType('oracle_full_node');
                assert.strictEqual(full.length, 1, 'one share per source');
                assert.strictEqual(full[0].args[0], PUBKEY_A);
                assert.strictEqual(Number(full[0].args[3]), 2.5); // whole 2.5 tranche
                // base: 7.5 / 2 = 3.75 each
                const base = rewardsByType('oracle_base');
                assert.strictEqual(base.length, 2);
                for (const c of base) assert.strictEqual(Number(c.args[3]), 3.75);
            });

            it('share == 0 keeps the legacy oracle_round pot (no full-node lookup)', async function () {
                indexer.config.FULLNODE = Object.assign({}, indexer.config.FULLNODE, { REWARD_SHARE: '0' });
                const data = v0Data();
                await handler.parse(v0Params(ONE_PAIR, [
                    { pubkey: PUBKEY_A, sig: SIG_A },
                    { pubkey: PUBKEY_B, sig: SIG_B },
                    { pubkey: PUBKEY_C, sig: SIG_C },
                ]), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
                assert.strictEqual(rewardsByType('oracle_round').length, 3);
                assert.strictEqual(rewardsByType('oracle_base').length, 0);
                assert.strictEqual(rewardsByType('oracle_full_node').length, 0);
                assert.ok(indexer.indexerDb.getFullNodeParticipation.notCalled,
                    'no full-node lookup when the feature is off');
            });
        });

        // Determinism (reindex-safe): rewards must be a pure function of the
        // on-chain inputs, independent of DB row order or signer wire order, so a
        // from-genesis replay reproduces byte-identical validator_rewards.
        describe('reward derivation is order-independent', function () {
            // SA has two passing keys {A, C} (rep = min = A); SB has {B} (rep = B).
            const PART = {
                totalEpochs: 7,
                sources: [
                    { source_id: 1, source: 'addrA', passed_epochs: 7, pubkeys: new Set([PUBKEY_A, PUBKEY_C]) },
                    { source_id: 2, source: 'addrB', passed_epochs: 7, pubkeys: new Set([PUBKEY_B]) },
                ],
            };
            function captured() {
                return indexer.indexerDb.createValidatorReward.getCalls()
                    .map(c => `${c.args[0]}|${c.args[1]}|${c.args[2]}|${String(c.args[3])}`)
                    .sort();
            }
            beforeEach(function () {
                indexer.config.FULLNODE = Object.assign({}, indexer.config.FULLNODE, { REWARD_SHARE: '0.25' });
                indexer.indexerDb.getFullNodeParticipation = sinon.stub().resolves(PART);
                indexer.indexerDb.getActiveCapabilityCount.resolves(3); // quorum 2
                setCapable(indexer.indexerDb, (pk, cap) =>
                    cap !== 'full_node' ? true : [PUBKEY_A, PUBKEY_B, PUBKEY_C].includes(pk));
            });
            afterEach(function () {
                indexer.config.FULLNODE = Object.assign({}, indexer.config.FULLNODE, { REWARD_SHARE: '0' });
            });

            const SIGS = [
                { pubkey: PUBKEY_A, sig: SIG_A },
                { pubkey: PUBKEY_B, sig: SIG_B },
                { pubkey: PUBKEY_C, sig: SIG_C },
            ];

            it('identical on replay (same inputs → same rows)', async function () {
                await handler.parse(v0Params(ONE_PAIR, SIGS), v0Data(), null);
                const first = captured();
                indexer.indexerDb.createValidatorReward.resetHistory();
                await handler.parse(v0Params(ONE_PAIR, SIGS), v0Data(), null);
                assert.deepStrictEqual(captured(), first);
            });

            it('independent of getFullNodeParticipation source order', async function () {
                await handler.parse(v0Params(ONE_PAIR, SIGS), v0Data(), null);
                const ordered = captured();
                indexer.indexerDb.createValidatorReward.resetHistory();
                indexer.indexerDb.getFullNodeParticipation.resolves({
                    totalEpochs: PART.totalEpochs,
                    sources: [PART.sources[1], PART.sources[0]], // reversed
                });
                await handler.parse(v0Params(ONE_PAIR, SIGS), v0Data(), null);
                assert.deepStrictEqual(captured(), ordered);
                // and the per-source representatives are the lexicographically smallest
                const full = ordered.filter(x => x.includes('oracle_full_node')).map(x => x.split('|')[0]).sort();
                assert.deepStrictEqual(full, [PUBKEY_A, PUBKEY_B].sort());
            });

            it('independent of signer wire order (rep stays the min pubkey, not first-seen)', async function () {
                await handler.parse(v0Params(ONE_PAIR, SIGS), v0Data(), null);
                const ascending = captured();
                indexer.indexerDb.createValidatorReward.resetHistory();
                // reverse the signature order on the wire
                await handler.parse(v0Params(ONE_PAIR, [SIGS[2], SIGS[1], SIGS[0]]), v0Data(), null);
                assert.deepStrictEqual(captured(), ascending);
            });
        });
    });

    describe('v0 - stake-weighted quorum', function () {
        function v0Params(pairs, sigs) {
            const out = ['0', '7', '1700000000', '799000', String(pairs.length)];
            for (const pr of pairs) { out.push(pr.pair, pr.price); }
            out.push(String(sigs.length));
            for (const s of sigs) { out.push(s.pubkey, s.sig); }
            return out;
        }
        function v0Data(overrides = {}) {
            return createBaseData({ ACTION: 'PRICE', FORMAT: 0, BLOCK_INDEX: 100, ...overrides });
        }
        const ONE_PAIR = [{ pair: 'BTC/USD', price: '50000' }];

        // Valid 64-hex pubkey / 128-hex sig from a byte value.
        const pk = (n) => n.toString(16).padStart(2, '0').repeat(32);
        const sg = (n) => n.toString(16).padStart(2, '0').repeat(64);

        // One whale source holds the supermajority of stake; nine Sybil sources hold
        // 1 each. S = 100000 + 9 = 100009.
        const WHALE = { pubkey: PUBKEY_A, source: 'WHALE', weight: '100000' };
        const SYBILS = [];
        for (let i = 0; i < 9; i++) SYBILS.push({ pubkey: pk(i), source: 'SYB' + i, weight: '1' });
        const SNAPSHOT = [WHALE].concat(SYBILS);

        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
            sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(true);
            indexer.indexerDb.getStakeWeightsByCapability.resolves(SNAPSHOT);
        });

        it('SECURITY: a COUNT supermajority of low-stake Sybils cannot finalize', async function () {
            // All nine Sybils sign - a 9-of-10 COUNT landslide - but only 9/100009 stake:
            // 3·9 = 27 !> 2·100009. Stake, not headcount, gates finalization.
            const data = v0Data();
            await handler.parse(v0Params(ONE_PAIR, SYBILS.map(s => ({ pubkey: s.pubkey, sig: sg(1) }))), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(String(data['STATUS']).includes('stake'));
        });

        it('a single majority-STAKE signer finalizes alone (COUNT minority of one)', async function () {
            // The whale alone: 3·100000 = 300000 > 2·100009 = 200018 → valid.
            const data = v0Data();
            await handler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
        });

        it('uses the source-keyed weight query, not the count query', async function () {
            const data = v0Data();
            await handler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);
            assert.ok(indexer.indexerDb.getStakeWeightsByCapability.calledWith('price', data['BLOCK_INDEX']));
            assert.ok(indexer.indexerDb.getActiveCapabilityCount.notCalled);
        });
    });

    describe('v1 - user oracle price', function () {

        // PRICE|1|COIN|TICK|FIAT|VALUE|FEE|MEMO
        function v1Params(overrides = {}) {
            const p = { coin: 'BTC', tick: 'TEST', fiat: 'USD', value: '1.50', fee: '0', memo: 'm', ...overrides };
            return ['1', p.coin, p.tick, p.fiat, p.value, p.fee, p.memo];
        }
        function v1Data(overrides = {}) {
            return createBaseData({ ACTION: 'PRICE', FORMAT: 1, ...overrides });
        }

        it('valid oracle price → valid and recorded', async function () {
            const data = v1Data();
            await handler.parse(v1Params(), data, null);
            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createPrice.calledOnce);
        });

        it('rejects an unsupported COIN', async function () {
            const data = v1Data();
            await handler.parse(v1Params({ coin: 'XRP' }), data, null);
            assert.ok(String(data['STATUS']).includes('COIN'));
        });

        it('rejects an unsupported FIAT', async function () {
            const data = v1Data();
            await handler.parse(v1Params({ fiat: 'ZZZ' }), data, null);
            assert.ok(String(data['STATUS']).includes('FIAT'));
        });

        it('rejects a non-positive VALUE', async function () {
            const data = v1Data();
            await handler.parse(v1Params({ value: '0' }), data, null);
            assert.ok(String(data['STATUS']).includes('VALUE'));
        });

        it('uses the exact bcmath comparator for VALUE positivity, matching the FEE sibling (2396)', async function () {
            // Zero in any decimal form is rejected; the smallest representable positive
            // 8-decimal amount is accepted. The positivity gate now runs through
            // util.bclte (exact) rather than parseFloat, matching the V1_FEE check.
            for (const value of ['0', '0.00000000']) {
                const data = v1Data();
                await handler.parse(v1Params({ value }), data, null);
                assert.ok(String(data['STATUS']).includes('VALUE'), 'VALUE ' + value + ' should be rejected');
            }
            const okData = v1Data();
            await handler.parse(v1Params({ value: '0.00000001' }), okData, null);
            assert.strictEqual(okData['VALIDATION_STATUS'], 'valid', 'smallest positive 8-decimal VALUE should be valid');
        });

        it('accepts boundary FEE values 0, 1 and a legitimate fraction', async function () {
            for (const fee of ['0', '1', '0.05', '0.999999999999999999']) {
                const data = v1Data();
                await handler.parse(v1Params({ fee }), data, null);
                assert.strictEqual(data['VALIDATION_STATUS'], 'valid', 'FEE ' + fee + ' should be valid');
            }
        });

        it('rejects an unbounded-precision FEE just above 1 (parseFloat rounding bypass)', async function () {
            // parseFloat('1.0000000000000000001') === 1, so the old parseFloat > 1
            // gate accepted it; exact bcmath now rejects it.
            for (const fee of ['1.0000000000000000001', '1.000000000000000000000001']) {
                const data = v1Data();
                await handler.parse(v1Params({ fee }), data, null);
                assert.ok(String(data['STATUS']).includes('FEE'), 'FEE ' + fee + ' should be rejected');
            }
        });
    });

    it('rejects an unknown VERSION', async function () {
        const data = createBaseData({ ACTION: 'PRICE', FORMAT: 9 });
        await handler.parse(['9'], data, null);
        assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
        assert.ok(indexer.indexerDb.createPrice.calledOnce);
    });

    describe('hub push - v0', function () {
        function v0Params(pairs, sigs) {
            const out = ['0', '7', '1700000000', '799000', String(pairs.length)];
            for (const pr of pairs) { out.push(pr.pair, pr.price); }
            out.push(String(sigs.length));
            for (const s of sigs) { out.push(s.pubkey, s.sig); }
            return out;
        }
        const ONE_PAIR = [{ pair: 'BTC/USD', price: '50000' }];

        beforeEach(function () {
            sinon.stub(ed25519, 'verify').returns(true);
            sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        });

        // The forward push now goes through a durable transactional outbox: parse writes the
        // pending_hub_pushes row via enqueueHubPushTx (inside the block transaction) and stages it
        // for a post-commit live delivery. parse itself never calls pushPriceRound, so a crash
        // between commit and delivery cannot drop the round, and a same-block rollback unwinds the
        // outbox row instead of leaving a phantom push.
        it('valid v0 with hubClient → durable outbox row enqueued + staged (no direct push)', async function () {
            const mockHubClient = { enabled: true, pushPriceRound: sinon.stub().resolves() };
            indexer.indexerDb.enqueueHubPushTx = sinon.stub().resolves(42);
            indexer.indexerDb.stageHubPush = sinon.stub();
            indexer.indexerDb.getActiveCapabilityCount.resolves(1);

            const localActionsCtx = {
                config:    indexer.config,
                util:      indexer.util,
                mapper:    indexer.mapper,
                decoderDb: indexer.decoderDb,
                indexerDb: indexer.indexerDb,
                hubClient: mockHubClient,
            };
            const localHandler = new Price(localActionsCtx);

            const data = createBaseData({ ACTION: 'PRICE', FORMAT: 0, BLOCK_INDEX: 100 });
            await localHandler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
            // Durable row written transactionally, NOT delivered from within parse.
            assert.ok(indexer.indexerDb.enqueueHubPushTx.calledOnce);
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.firstCall.args[0], 'price_round');
            assert.ok(!mockHubClient.pushPriceRound.called);
            // Staged for post-commit delivery, carrying the durable row id and the payload.
            assert.ok(indexer.indexerDb.stageHubPush.calledOnce);
            const staged = indexer.indexerDb.stageHubPush.firstCall.args[0];
            assert.strictEqual(staged.id, 42);
            assert.strictEqual(staged.pushType, 'price_round');
            // #4232: the payload must carry the round's BTC anchor for the hub re-verify.
            assert.strictEqual(staged.payload.btc_block_height, 799000);
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.firstCall.args[1].btc_block_height, 799000);
        });

        it('invalid v0 with hubClient → nothing enqueued or staged', async function () {
            const mockHubClient = { enabled: true, pushPriceRound: sinon.stub().resolves() };
            indexer.indexerDb.enqueueHubPushTx = sinon.stub().resolves(1);
            indexer.indexerDb.stageHubPush = sinon.stub();
            // Fail quorum by returning false for all sigs
            ed25519.verify.returns(false);
            indexer.indexerDb.getActiveCapabilityCount.resolves(1);

            const localActionsCtx = {
                config:    indexer.config,
                util:      indexer.util,
                mapper:    indexer.mapper,
                decoderDb: indexer.decoderDb,
                indexerDb: indexer.indexerDb,
                hubClient: mockHubClient,
            };
            const localHandler = new Price(localActionsCtx);

            const data = createBaseData({ ACTION: 'PRICE', FORMAT: 0, BLOCK_INDEX: 100 });
            await localHandler.parse(v0Params(ONE_PAIR, [{ pubkey: PUBKEY_A, sig: SIG_A }]), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(!mockHubClient.pushPriceRound.called);
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called);
            assert.ok(!indexer.indexerDb.stageHubPush.called);
        });
    });

    describe('hub push - v1', function () {
        function v1Params(overrides = {}) {
            const p = { coin: 'BTC', tick: 'TEST', fiat: 'USD', value: '1.50', fee: '0', memo: 'm', ...overrides };
            return ['1', p.coin, p.tick, p.fiat, p.value, p.fee, p.memo];
        }

        // A v1 oracle_price is user-submitted and never re-emitted by a later block, so its lost-push
        // window was permanent. It now uses the same durable transactional outbox as v0: enqueueHubPushTx
        // inside the block transaction plus a staged post-commit delivery; parse never pushes directly.
        it('valid v1 with hubClient → durable outbox row enqueued + staged (no direct push)', async function () {
            const mockHubClient = { enabled: true, pushOraclePrice: sinon.stub().resolves() };
            indexer.indexerDb.enqueueHubPushTx = sinon.stub().resolves(7);
            indexer.indexerDb.stageHubPush = sinon.stub();

            const localActionsCtx = {
                config:    indexer.config,
                util:      indexer.util,
                mapper:    indexer.mapper,
                decoderDb: indexer.decoderDb,
                indexerDb: indexer.indexerDb,
                hubClient: mockHubClient,
            };
            const localHandler = new Price(localActionsCtx);

            const data = createBaseData({ ACTION: 'PRICE', FORMAT: 1 });
            await localHandler.parse(v1Params(), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'valid');
            assert.ok(indexer.indexerDb.enqueueHubPushTx.calledOnce);
            assert.strictEqual(indexer.indexerDb.enqueueHubPushTx.firstCall.args[0], 'oracle_price');
            assert.ok(!mockHubClient.pushOraclePrice.called);
            assert.ok(indexer.indexerDb.stageHubPush.calledOnce);
            const staged = indexer.indexerDb.stageHubPush.firstCall.args[0];
            assert.strictEqual(staged.id, 7);
            assert.strictEqual(staged.pushType, 'oracle_price');
        });

        it('invalid v1 with hubClient → nothing enqueued or staged', async function () {
            const mockHubClient = { enabled: true, pushOraclePrice: sinon.stub().resolves() };
            indexer.indexerDb.enqueueHubPushTx = sinon.stub().resolves(1);
            indexer.indexerDb.stageHubPush = sinon.stub();

            const localActionsCtx = {
                config:    indexer.config,
                util:      indexer.util,
                mapper:    indexer.mapper,
                decoderDb: indexer.decoderDb,
                indexerDb: indexer.indexerDb,
                hubClient: mockHubClient,
            };
            const localHandler = new Price(localActionsCtx);

            // Invalid - unsupported FIAT
            const data = createBaseData({ ACTION: 'PRICE', FORMAT: 1 });
            await localHandler.parse(v1Params({ fiat: 'ZZZ' }), data, null);

            assert.strictEqual(data['VALIDATION_STATUS'], 'invalid');
            assert.ok(!mockHubClient.pushOraclePrice.called);
            assert.ok(!indexer.indexerDb.enqueueHubPushTx.called);
            assert.ok(!indexer.indexerDb.stageHubPush.called);
        });
    });
});

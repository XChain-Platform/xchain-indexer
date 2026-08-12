'use strict';

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
 * test/unit/lock-null-prior-unset.test.js
 *
 * the LOCK action could not lock anything.
 *
 * getTokenInfo rebuilds token state by replaying the `issues` rows and SKIPS any
 * column that is NULL, so a token whose genesis ISSUE simply omitted the lock
 * fields (the create-time "don't lock anything" path; 108 of 109 ticks measured on
 * the BTC regtest venue) reached isValidLock with an UNDEFINED prior. Every test in
 * that function is a loose-equality comparison against '' / value / 0, and
 * `undefined` matches none of them, so it fell through to false and issue.js
 * reported "invalid: <FIELD> (locked)" for a flag that had never been locked. An
 * owner could therefore never freeze supply/description/mint after launch, every
 * attempt burned a protocol fee on a guaranteed-invalid action, and the refusal
 * text asserted the exact opposite of the truth (the read APIs report the flag as
 * unlocked, because the materialized `tokens` row stores 0 where `issues` stores
 * NULL).
 *
 * The fix treats an unset prior as unlocked, which CHANGES WHICH ACTIONS ARE VALID.
 * It was originally built behind a LOCK_NULL_PRIOR_UNSET flag-day on the v1
 * three-key train (Key A / shared mainnet block TIME 1796083200). The
 * REDESIGN (spec §0) retired that activation surface: the platform has not launched,
 * all derived state is operator-owned, and the batch ships ungated behind one
 * mandatory fleet-wide wipe-and-replay rebase instead. So the rule is now
 * registered with all-zero gates on every network, and the Key A constant is gone.
 *
 * The handler still resolves the rule through isEnabled(), which simply always
 * returns true for it now. That keeps the two verdict branches testable, which
 * matters: the gate-OFF branch is the PRE-BATCH verdict, and the §3.1 snapshot
 * diff needs it reproducible to adjudicate any historical LOCK whose validity
 * flips on replay.
 *
 * What these tests pin:
 *   1. the root cause: a NULL lock column replays to an ABSENT key, not to 0;
 *   2. isValidLock semantics on both branches, including that locking
 *      stays one-way (1 -> 0 is still refused) under the shipped rule;
 *   3. the end-to-end ISSUE verdict, driving the exact on-chain repro
 *      `ISSUE|3|S20ADM|||1` that was rejected as action 1157;
 *   4. the registration itself: ungated on every network, the v1 train anchor
 *      retired, and NOT folded into the 2026-08-07 cohort.
 ********************************************************************/

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData, createTokenInfo } = require('../fixtures/mocks');
const { getTestConfig } = require('../fixtures/config');

const Utility         = require('../../src/utility.js');
const Database        = require('../../src/db.js');
const Issue           = require('../../src/actions/issue.js');
const ProtocolChanges = require('../../src/protocol_changes.js');

// The seven token locks, in the order issue.js validates them.
const ALL_LOCKS = [
    'LOCK_MAX_SUPPLY', 'LOCK_MINT', 'LOCK_MINT_SUPPLY', 'LOCK_MAX_MINT',
    'LOCK_DESCRIPTION', 'LOCK_SLEEP', 'LOCK_CALLBACK'
];

// tokenInfo as getTokenInfo actually returns it for a token issued WITHOUT
// create-time locks: the LOCK_* keys are absent entirely (the replay loop skips
// NULL values), not present-and-zero the way the naive fixture models them.
function tokenInfoWithUnsetLocks(overrides = {}) {
    const info = createTokenInfo(overrides);
    for (const lock of ALL_LOCKS)
        if (!(lock in overrides)) delete info[lock];
    return info;
}


describe('LOCK_NULL_PRIOR_UNSET @regression @tier1', function () {

    /*****************************************************************
     * 1. Root cause: NULL lock columns replay to an ABSENT key
     ****************************************************************/

    describe('getTokenInfo replay of a genesis ISSUE that omitted the lock fields', function () {

        // Build a Database whose issues-row query returns one genesis row with NULL in
        // every lock column, which is what the omitted-field wire path stores.
        function makeDb() {
            const config = getTestConfig();
            const util   = new Utility();
            sinon.stub(util, 'logError');
            const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
            sinon.stub(db, 'createTicker').resolves(1);
            sinon.stub(db, 'getTokenSupply').resolves('0');
            return db;
        }

        afterEach(function () { sinon.restore(); });

        it('leaves every LOCK_ key unset rather than defaulting it to 0', async function () {
            const db = makeDb();
            sinon.stub(db, 'doQuery').resolves([{
                max_supply: '1000', max_mint: '100', decimals: 0, description: 'S20 admin token',
                lock_max_supply: null, lock_mint_supply: null, lock_mint: null, lock_max_mint: null,
                lock_description: null, lock_sleep: null, lock_callback: null,
                callback_block: null, callback_amount: null, mint_address_max: null,
                mint_start_block: null, mint_stop_block: null, allow_list: null, block_list: null,
                action_index: 1150, block_index: 900, tick: 'S20ADM', callback_tick: null,
                owner: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH', transfer: null
            }]);

            const info = await db.getTokenInfo('S20ADM', 1000, 2000);

            assert.ok(info, 'the token must resolve');
            for (const lock of ALL_LOCKS) {
                assert.strictEqual(info[lock], undefined,
                    lock + ' must replay as unset (the NULL column is skipped), not as 0');
            }
        });

        it('an explicit 0 in the issues row still replays as 0', async function () {
            const db = makeDb();
            sinon.stub(db, 'doQuery').resolves([{
                max_supply: '1000', max_mint: '100', decimals: 0, description: 'explicit zeros',
                lock_max_supply: 0, lock_mint_supply: 0, lock_mint: 0, lock_max_mint: 0,
                lock_description: 0, lock_sleep: 0, lock_callback: 0,
                callback_block: null, callback_amount: null, mint_address_max: null,
                mint_start_block: null, mint_stop_block: null, allow_list: null, block_list: null,
                action_index: 10, block_index: 900, tick: 'ZEROS', callback_tick: null,
                owner: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH', transfer: null
            }]);

            const info = await db.getTokenInfo('ZEROS', 1000, 2000);
            assert.strictEqual(info.LOCK_DESCRIPTION, 0);
        });
    });

    /*****************************************************************
     * 2. isValidLock semantics on both sides of the gate
     ****************************************************************/

    describe('isValidLock()', function () {

        const util = new Utility();

        // Both shapes an "unset" prior can take: `undefined` (getTokenInfo's replay skip,
        // the shape that actually reaches the consensus path) and an explicit `null` (a
        // caller reading the raw column). Neither may be read as "locked".
        for (const [label, prior] of [['undefined', undefined], ['null', null]]) {

            it('gate OFF: a ' + label + ' prior is refused (the legacy verdict, preserved for replay)', function () {
                const info = { LOCK_DESCRIPTION: prior };
                assert.strictEqual(util.isValidLock(info, { LOCK_DESCRIPTION: '1' }, 'LOCK_DESCRIPTION', false), false);
            });

            it('gate ON: a ' + label + ' prior is treated as unset and the lock is accepted', function () {
                const info = { LOCK_DESCRIPTION: prior };
                assert.strictEqual(util.isValidLock(info, { LOCK_DESCRIPTION: '1' }, 'LOCK_DESCRIPTION', true), true);
            });
        }

        it('gate OFF: the absent-key shape getTokenInfo really produces is refused', function () {
            assert.strictEqual(
                util.isValidLock(tokenInfoWithUnsetLocks(), { LOCK_DESCRIPTION: '1' }, 'LOCK_DESCRIPTION', false),
                false);
        });

        it('gate ON: the absent-key shape is accepted for every one of the seven locks', function () {
            const info = tokenInfoWithUnsetLocks();
            for (const lock of ALL_LOCKS)
                assert.strictEqual(util.isValidLock(info, { [lock]: '1' }, lock, true), true,
                    lock + ' must be lockable from an unset prior once the flag-day is active');
        });

        it('gate ON: locking stays ONE-WAY - an already-locked flag still cannot be unlocked', function () {
            const info = { LOCK_DESCRIPTION: 1 };
            assert.strictEqual(util.isValidLock(info, { LOCK_DESCRIPTION: '0' }, 'LOCK_DESCRIPTION', true), false);
            assert.strictEqual(util.isValidLock(info, { LOCK_DESCRIPTION: 0 }, 'LOCK_DESCRIPTION', true), false);
        });

        it('gate ON: re-asserting an already-locked flag (1 -> 1) is still valid', function () {
            assert.strictEqual(util.isValidLock({ LOCK_MINT: 1 }, { LOCK_MINT: '1' }, 'LOCK_MINT', true), true);
        });

        it('the gate argument defaults to OFF when a caller omits it', function () {
            // The mutation/fuzz suites and any future caller invoke the 3-arg form; that
            // must keep resolving to the legacy verdict rather than silently activating a
            // consensus rule.
            assert.strictEqual(util.isValidLock({ LOCK_MINT: undefined }, { LOCK_MINT: '1' }, 'LOCK_MINT'), false);
        });

        it('the gate does not disturb the priors that already worked', function () {
            for (const active of [false, true]) {
                assert.strictEqual(util.isValidLock(null, { LOCK_MINT: '1' }, 'LOCK_MINT', active), true,
                    'a brand-new tick is always valid');
                assert.strictEqual(util.isValidLock({ LOCK_MINT: 0 }, { LOCK_MINT: '1' }, 'LOCK_MINT', active), true,
                    '0 -> 1 stays valid');
                assert.strictEqual(util.isValidLock({ LOCK_MINT: '' }, { LOCK_MINT: '1' }, 'LOCK_MINT', active), true,
                    'an empty-string prior stays valid');
                assert.strictEqual(util.isValidLock({ LOCK_MINT: 1 }, { LOCK_MINT: '0' }, 'LOCK_MINT', active), false,
                    'unlocking stays invalid');
            }
        });
    });

    /*****************************************************************
     * 3. End-to-end ISSUE verdict (the on-chain repro)
     ****************************************************************/

    describe('ISSUE format 3 against a token issued without create-time locks', function () {

        const SOURCE = createBaseData().SOURCE;

        // The exact wire the wallet's Lock screen composed for action 1157:
        // ISSUE|3|S20ADM|||1  ->  VERSION|TICK|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION
        const REPRO_PARAMS = ['3', 'S20ADM', '', '', '1'];

        function makeHandler(gateActive) {
            const indexer = createMockIndexer();
            indexer.indexerDb.getTokenInfo.resolves(
                tokenInfoWithUnsetLocks({ TICK: 'S20ADM', OWNER: SOURCE, SUPPLY: '0', MAX_SUPPLY: '1000' }));
            indexer.indexerDb.isActionAllowed.resolves(true);
            indexer.indexerDb.isDistributed.resolves(false);
            indexer.indexerDb.isOwnershipEscrowed.resolves(false);
            indexer.indexerDb.getAddressBalances.resolves({});
            indexer.indexerDb.getAddressPreferences.resolves({ FEE_PREFERENCE: 0, REQUIRE_MEMO: 0 });
            indexer.indexerDb.getTokenSupply.resolves('0');

            const actionsCtx = {
                config:    indexer.config,
                util:      indexer.util,
                mapper:    indexer.mapper,
                decoderDb: indexer.decoderDb,
                indexerDb: indexer.indexerDb,
                protocolChanges: {
                    isDefined: sinon.stub().returns(true),
                    // ISSUANCE_FEE is block-gated (mainnet 862633); mirror that so the
                    // sub-activation test block skips the fee. LOCK_NULL_PRIOR_UNSET is the
                    // gate under test; everything else is on.
                    isEnabled: sinon.stub().callsFake(async (name, block) => {
                        if (name === 'ISSUANCE_FEE') return Number(block) >= 862633;
                        if (name === 'LOCK_NULL_PRIOR_UNSET') return gateActive;
                        return true;
                    }),
                },
                processAction: sinon.stub().resolves(),
            };
            return { handler: new Issue(actionsCtx), indexer };
        }

        afterEach(function () { sinon.restore(); });

        // The registration is UNGATED after the redesign, so the gate-off branch is
        // no longer reachable in production. It is still pinned here on purpose: it is the
        // pre-batch verdict the §3.1 snapshot diff compares replayed state against, so it
        // has to stay reproducible to adjudicate any LOCK whose validity flips.
        it('gate OFF (pre-batch verdict): rejected with the (locked) text', async function () {
            const { handler } = makeHandler(false);
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 3, BLOCK_INDEX: 100 });
            await handler.parse(REPRO_PARAMS, data, null);
            assert.strictEqual(data.STATUS, 'invalid: LOCK_DESCRIPTION (locked)',
                'the historical verdict must be reproduced byte for byte below the flag-day');
        });

        it('gate ON (shipped rule): the same action indexes valid', async function () {
            const { handler } = makeHandler(true);
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 3, BLOCK_INDEX: 100 });
            await handler.parse(REPRO_PARAMS, data, null);
            assert.strictEqual(data.STATUS, 'valid', 'expected valid but got: ' + data.STATUS);
        });

        it('gate ON (shipped rule): the flag actually flips (LOCK_DESCRIPTION rides through as 1)', async function () {
            const { handler } = makeHandler(true);
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 3, BLOCK_INDEX: 100 });
            await handler.parse(REPRO_PARAMS, data, null);
            assert.strictEqual(data.STATUS, 'valid');
            assert.strictEqual(Number(data.LOCK_DESCRIPTION), 1,
                'a valid LOCK must carry the set flag into the token write, not just pass validation');
        });

        it('gate ON (shipped rule): an unlock attempt on an already-locked flag is still refused', async function () {
            const { handler, indexer } = makeHandler(true);
            indexer.indexerDb.getTokenInfo.resolves(tokenInfoWithUnsetLocks({
                TICK: 'S20ADM', OWNER: SOURCE, SUPPLY: '0', MAX_SUPPLY: '1000', LOCK_DESCRIPTION: 1
            }));
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 3, BLOCK_INDEX: 100 });
            await handler.parse(['3', 'S20ADM', '', '', '0'], data, null);
            assert.strictEqual(data.STATUS, 'invalid: LOCK_DESCRIPTION (locked)',
                'the (locked) refusal must survive for a flag that genuinely IS locked');
        });

        it('the gate is resolved once per action, not once per lock field', async function () {
            const { handler, indexer } = makeHandler(true);
            void indexer;
            const data = createBaseData({ ACTION: 'ISSUE', FORMAT: 3, BLOCK_INDEX: 100 });
            await handler.parse(['3', 'S20ADM', '1', '1', '1', '1', '1', '1', '1'], data, null);
            const calls = handler.actions.protocolChanges.isEnabled.getCalls()
                .filter(c => c.args[0] === 'LOCK_NULL_PRIOR_UNSET');
            assert.strictEqual(calls.length, 1,
                'one resolution per action: a per-field lookup could gate differently field to field');
            assert.strictEqual(Number(calls[0].args[1]), 100,
                'the gate must be evaluated against the processing block, never a wall clock');
        });
    });

    /*****************************************************************
     * 4. Flag-day registration
     ****************************************************************/

    describe('flag-day registration', function () {

        function makeChanges() {
            const util = new Utility();
            return new ProtocolChanges({
                config: getTestConfig(), util, decoderDb: null, indexerDb: null
            });
        }

        it('LOCK_NULL_PRIOR_UNSET is registered as a consensus change', function () {
            assert.strictEqual(makeChanges().isDefined('LOCK_NULL_PRIOR_UNSET'), true);
        });

        // Was: "it arms on the train anchor (2026-12-01)". The redesign
        // (spec §0) replaced the v1 three-key activation surface with a mandatory
        // fleet-wide wipe-and-replay rebase, so this rule ships ungated and the Key A
        // anchor is retired. Reintroducing a flag day here is a divergence window,
        // because a node replaying before the date and one replaying after would
        // compute different validity for the same historical LOCK.
        it('it ships UNGATED on every network (redesign, spec §0)', function () {
            const change = makeChanges().changes['LOCK_NULL_PRIOR_UNSET'];
            assert.strictEqual(change.mainnet_time, 0,
                'the redesign batch carries no activation dates; mainnet_time must be 0');
            assert.strictEqual(ProtocolChanges.XC637_TRAIN_TIME, undefined,
                'the v1 Key A anchor must be retired, not left dangling for a gate to re-adopt');
        });

        it('it is NOT folded into the 2026-08-07 cohort, which deploys on its own schedule', function () {
            const change = makeChanges().changes['LOCK_NULL_PRIOR_UNSET'];
            assert.notStrictEqual(change.mainnet_time, 1786060800);
        });

        it('testnet and regtest are armed from genesis so the new path gets real coverage', function () {
            const change = makeChanges().changes['LOCK_NULL_PRIOR_UNSET'];
            assert.strictEqual(change.testnet_time, 0);
            assert.strictEqual(change.regtest_time, 0);
            assert.strictEqual(change.mainnet_block, 0);
            assert.strictEqual(change.testnet_block, 0);
            assert.strictEqual(change.regtest_block, 0);
        });

        it('it ships in the 2.0.0 contract era, matching its ISSUE-validity siblings', function () {
            const change = makeChanges().changes['LOCK_NULL_PRIOR_UNSET'];
            assert.strictEqual(change.version_major, 2);
            assert.strictEqual(change.version_minor, 0);
            assert.strictEqual(change.version_revision, 0);
        });
    });
});

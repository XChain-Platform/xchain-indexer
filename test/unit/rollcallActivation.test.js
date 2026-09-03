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
 * ROLLCALL activation constants and epoch arithmetic.
 *
 * These eight values are consensus: they decide which epochs exist, which
 * signatures count, and at what BTC height an eviction and a COLLECT-spendable
 * reward materialise. This suite pins them three ways (indexer, hub twin,
 * canonical documentation copy) and pins the arithmetic that reads them.
 *
 * The mainnet placeholder gets a NAMED assertion here rather than riding
 * flagdayPlaceholderGuard.test.js, which asserts over hard-coded cohorts and
 * cannot take a null map.
 *
 * REGTEST ARMING (operator ruling 2026-09-01). Regtest is the one
 * network whose height a venue may pin for itself, because a regtest chain is
 * private and cannot fork anybody. The arming is exercised two ways: the pure
 * resolver is driven over every accepted and rejected form, and the module is
 * re-required under an armed environment to prove the whole gate chain
 * (isRollcallActive -> rollcallEpochClosingAt) turns on with it. The default
 * stays INERT, and that assertion is load-bearing: a hardcoded regtest height
 * wedged every single-coin BTC venue at its first close on 2026-08-31.
 *
 ********************************************************************/
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const act = require('../../src/rollcall_activation.js');

const ACT_PATH = require.resolve('../../src/rollcall_activation.js');

// Re-require the module with ROLLCALL_ACTIVATION resolved against `env`. The
// map is built at require time on purpose (an activation height that can change
// under a running process is not an activation height), so the only honest way
// to test the armed venue is to load a fresh copy.
function loadWithEnv(env){
    const saved = process.env[act.ROLLCALL_REGTEST_ENV];
    if(env === undefined) delete process.env[act.ROLLCALL_REGTEST_ENV];
    else process.env[act.ROLLCALL_REGTEST_ENV] = env;
    delete require.cache[ACT_PATH];
    try { return require(ACT_PATH); }
    finally {
        delete require.cache[ACT_PATH];
        if(saved === undefined) delete process.env[act.ROLLCALL_REGTEST_ENV];
        else process.env[act.ROLLCALL_REGTEST_ENV] = saved;
        require(ACT_PATH);   // restore the shared instance every other suite holds
    }
}

const NETWORKS = ['mainnet', 'testnet', 'regtest'];
const MAPS = [
    'ROLLCALL_ACTIVATION',
    'ROLLCALL_INTERVAL_BLOCKS',
    'ROLLCALL_ACCEPT_WINDOW_BLOCKS',
    'ROLLCALL_PROOF_DELAY_BLOCKS',
    'ROLLCALL_DOGE_MATURITY',
];
const SCALARS = ['ROLLCALL_EVICT_MISSES', 'ROLLCALL_STREAK_LOOKBACK', 'ROLLCALL_REWARD_AMOUNT'];

function loadCanonical(){
    return require('../../../xchain-documentation/protocol/constants.js');
}
function loadHub(){
    const p = path.join(__dirname, '../../../xchain-hub/src/rollcall_activation.js');
    if(!fs.existsSync(p)) throw new Error('xchain-hub sibling missing at ' + p);
    return { mod: require(p), file: p };
}

describe('rollcall_activation', function () {

    describe('the eight consensus values', function () {

        it('agrees with the canonical documentation copy', function () {
            let canon;
            try { canon = loadCanonical(); }
            catch (e) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('canonical constants missing: ' + e.message);
                return this.skip();
            }
            for (const name of MAPS.concat(SCALARS))
                assert.deepStrictEqual(act[name], canon[name], name + ' drifted from protocol/constants.js');
        });

        it('agrees with the hub twin', function () {
            let hub;
            try { hub = loadHub(); }
            catch (e) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw e;
                return this.skip();
            }
            for (const name of MAPS.concat(SCALARS))
                assert.deepStrictEqual(act[name], hub.mod[name], name + ' drifted between hub and indexer');
        });

        it('hub and indexer source are byte-identical apart from the twin-reference line', function () {
            let hub;
            try { hub = loadHub(); }
            catch (e) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1') throw e;
                return this.skip();
            }
            const TWIN_REF = /xchain-\S+\/src\/rollcall_activation\.js/;
            const norm = (p) => fs.readFileSync(p, 'utf8')
                .split(/\r?\n/)
                .map(l => TWIN_REF.test(l) ? '<TWIN-REF>' : l)
                .join('\n');
            assert.strictEqual(
                norm(path.join(__dirname, '../../src/rollcall_activation.js')),
                norm(hub.file),
                'rollcall_activation.js drifted between hub and indexer (only the twin-reference line may differ)'
            );
        });

        // D96: flagdayPlaceholderGuard cannot take a null map, so the lock lives here.
        it('MAINNET SHIPS INERT: ROLLCALL_ACTIVATION.mainnet is null', function () {
            assert.strictEqual(act.ROLLCALL_ACTIVATION.mainnet, null,
                'mainnet must stay inert until the operator pins a height with the mainnet federation');
        });

        it('the streak lookback is exactly 2K', function () {
            assert.strictEqual(act.ROLLCALL_STREAK_LOOKBACK, 2 * act.ROLLCALL_EVICT_MISSES);
        });

        it('the proof delay is at least 1 on every network', function () {
            // block_time for a block is written AFTER that block's own processing, so the
            // window endpoint must be a strictly earlier block than the close.
            for (const net of NETWORKS)
                assert.ok(act.ROLLCALL_PROOF_DELAY_BLOCKS[net] >= 1, net + ' proof delay must be >= 1');
        });

        it('an epoch closes before the next one opens on every network', function () {
            for (const net of NETWORKS) {
                const span = act.ROLLCALL_ACCEPT_WINDOW_BLOCKS[net] + act.ROLLCALL_PROOF_DELAY_BLOCKS[net];
                assert.ok(span < act.ROLLCALL_INTERVAL_BLOCKS[net],
                    net + ': close offset ' + span + ' must be under the ' + act.ROLLCALL_INTERVAL_BLOCKS[net] + '-block interval');
            }
        });

        it('the armed testnet height is a real epoch boundary', function () {
            assert.strictEqual(act.ROLLCALL_ACTIVATION.testnet % act.ROLLCALL_INTERVAL_BLOCKS.testnet, 0,
                'an activation height that is not an epoch boundary would skip the first epoch');
        });

        it('the documented regtest arming height is a real epoch boundary', function () {
            assert.strictEqual(act.ROLLCALL_REGTEST_ARMED_HEIGHT % act.ROLLCALL_INTERVAL_BLOCKS.regtest, 0,
                'an arming height that is not an epoch boundary would skip the venue\'s first epoch');
        });
    });

    // The 2026-09-01 ruling scopes the no-tunable-input rule to
    // shared-ledger networks and gives regtest a documented arming height.
    describe('the regtest arming opt-in', function () {

        it('REGTEST SHIPS INERT: an unset environment arms nothing', function () {
            const m = loadWithEnv(undefined);
            assert.strictEqual(m.ROLLCALL_ACTIVATION.regtest, null,
                'arming by default re-wedges every single-coin BTC regtest venue at its first close, ' +
                'which is the 2026-08-31 finding');
            assert.strictEqual(m.isRollcallActive(0, 'regtest'), false);
            assert.strictEqual(m.isRollcallActive(99999, 'regtest'), false);
        });

        it('arms at the documented height 0 on every accepted opt-in word', function () {
            for (const word of ['armed', 'genesis', 'on', 'true', 'yes', 'ARMED', ' Genesis '])
                assert.strictEqual(act.resolveRegtestActivation({ [act.ROLLCALL_REGTEST_ENV]: word }),
                    act.ROLLCALL_REGTEST_ARMED_HEIGHT, word + ' must arm at the documented height');
        });

        it('takes a bare non-negative height, for a venue with an indexed prefix', function () {
            assert.strictEqual(act.resolveRegtestActivation({ [act.ROLLCALL_REGTEST_ENV]: '0' }), 0);
            assert.strictEqual(act.resolveRegtestActivation({ [act.ROLLCALL_REGTEST_ENV]: '30' }), 30);
            assert.strictEqual(act.resolveRegtestActivation({ [act.ROLLCALL_REGTEST_ENV]: ' 600 ' }), 600);
        });

        it('stays inert on every off word, an empty value and a missing env', function () {
            for (const word of ['', '   ', 'off', 'inert', 'false', 'no', 'none', 'OFF'])
                assert.strictEqual(act.resolveRegtestActivation({ [act.ROLLCALL_REGTEST_ENV]: word }), null,
                    JSON.stringify(word) + ' must leave regtest inert');
            assert.strictEqual(act.resolveRegtestActivation({}), null);
            assert.strictEqual(act.resolveRegtestActivation(null), null);
        });

        it('FAILS CLOSED on garbage rather than arming a venue nobody meant to arm', function () {
            const saved = console.error;
            const said = [];
            console.error = (m) => said.push(String(m));
            try {
                for (const junk of ['-1', '1e3', '0x0', 'maybe', '30.5'])
                    assert.strictEqual(act.resolveRegtestActivation({ [act.ROLLCALL_REGTEST_ENV]: junk }), null,
                        JSON.stringify(junk) + ' must not arm');
            } finally { console.error = saved; }
            assert.strictEqual(said.length, 5, 'every ignored value must say so on stderr');
            assert.ok(said[0].indexOf(act.ROLLCALL_REGTEST_ENV) !== -1,
                'the warning must name the variable the operator has to fix');
        });

        it('an ARMED venue turns the whole gate chain on, not just the map', function () {
            const m = loadWithEnv('armed');
            assert.strictEqual(m.ROLLCALL_ACTIVATION.regtest, 0);
            assert.strictEqual(m.isRollcallActive(0, 'regtest'), true, 'epoch 0 is a real epoch on an armed venue');
            assert.strictEqual(m.isRollcallActive(30, 'regtest'), true);
            const C = m.rollcallCloseHeight(30, 'regtest');
            assert.strictEqual(C, 44, 'E + window 12 + proof delay 2');
            assert.strictEqual(m.rollcallEpochClosingAt(C, 'regtest'), 30,
                'the close block must resolve back to its epoch once the venue is armed');
        });

        it('an arming height above genesis leaves the epochs below it inert', function () {
            const m = loadWithEnv('60');
            assert.strictEqual(m.isRollcallActive(30, 'regtest'), false);
            assert.strictEqual(m.isRollcallActive(60, 'regtest'), true);
            assert.strictEqual(m.rollcallEpochClosingAt(m.rollcallCloseHeight(30, 'regtest'), 'regtest'), null);
            assert.strictEqual(m.rollcallEpochClosingAt(m.rollcallCloseHeight(60, 'regtest'), 'regtest'), 60);
        });

        it('NEITHER shared-ledger network is reachable from the environment', function () {
            const m = loadWithEnv('armed');
            assert.strictEqual(m.ROLLCALL_ACTIVATION.mainnet, null, 'mainnet must never be env-tunable');
            assert.strictEqual(m.ROLLCALL_ACTIVATION.testnet, 151200, 'testnet must never be env-tunable');
            const src = fs.readFileSync(ACT_PATH, 'utf8');
            const envReads = src.match(/process\.env/g) || [];
            assert.strictEqual(envReads.length, 1,
                'exactly one env read may exist in this file, and it is the regtest opt-in');
        });
    });

    describe('isRollcallActive', function () {

        // 0 >= null is TRUE in JS, so a bare comparison arms mainnet at height 0.
        it('never arms an inert mainnet, at any height', function () {
            assert.strictEqual(0 >= act.ROLLCALL_ACTIVATION.mainnet, true, 'the JS trap this guard exists for');
            for (const h of [0, 1, 961000, 99999999])
                assert.strictEqual(act.isRollcallActive(h, 'mainnet'), false, 'mainnet armed at ' + h);
        });

        it('gates testnet exactly at its height', function () {
            assert.strictEqual(act.isRollcallActive(151199, 'testnet'), false);
            assert.strictEqual(act.isRollcallActive(151200, 'testnet'), true);
            assert.strictEqual(act.isRollcallActive(151201, 'testnet'), true);
        });

        // Regtest is inert by the 2026-08-31 ruling, for the same JS trap reason
        // mainnet is: a single-coin BTC regtest venue has no DOGE peer, and the
        // close halts rather than read silence as absence, so an armed height
        // wedged every such venue at its first epoch close.
        it('never arms an inert regtest, at any height', function () {
            assert.strictEqual(0 >= act.ROLLCALL_ACTIVATION.regtest, true, 'the JS trap this guard exists for');
            for (const h of [0, 30, 60, 99999999])
                assert.strictEqual(act.isRollcallActive(h, 'regtest'), false, 'regtest armed at ' + h);
        });

        it('is active from genesis on an ARMED regtest venue, epoch 0 included', function () {
            assert.strictEqual(loadWithEnv('armed').isRollcallActive(0, 'regtest'), true);
        });

        it('fails closed on an unknown network or unparseable height', function () {
            assert.strictEqual(act.isRollcallActive(5, 'bogusnet'), false);
            assert.strictEqual(act.isRollcallActive('abc', 'regtest'), false);
            assert.strictEqual(act.isRollcallActive(null, 'regtest'), false);
            assert.strictEqual(act.isRollcallActive(undefined, 'regtest'), false);
        });
    });

    describe('isRollcallEpoch', function () {

        it('treats regtest height 0 as a REAL epoch, not a falsy skip', function () {
            assert.strictEqual(act.isRollcallEpoch(0, 'regtest'), true);
        });

        it('accepts multiples of the interval and rejects the rest', function () {
            assert.strictEqual(act.isRollcallEpoch(30, 'regtest'), true);
            assert.strictEqual(act.isRollcallEpoch(60, 'regtest'), true);
            assert.strictEqual(act.isRollcallEpoch(31, 'regtest'), false);
            assert.strictEqual(act.isRollcallEpoch(151200, 'testnet'), true);
            assert.strictEqual(act.isRollcallEpoch(151201, 'testnet'), false);
        });

        it('fails closed on a negative height, an unknown network, or garbage', function () {
            assert.strictEqual(act.isRollcallEpoch(-30, 'regtest'), false);
            assert.strictEqual(act.isRollcallEpoch(30, 'bogusnet'), false);
            assert.strictEqual(act.isRollcallEpoch('abc', 'regtest'), false);
        });
    });

    describe('epoch close arithmetic', function () {

        it('C = E + window + proof delay', function () {
            assert.strictEqual(act.rollcallWindowEndHeight(30, 'regtest'), 42);
            assert.strictEqual(act.rollcallCloseHeight(30, 'regtest'), 44);
            assert.strictEqual(act.rollcallCloseHeight(151200, 'testnet'), 151200 + 144 + 36);
        });

        // Testnet is the only network shipping armed, so it carries this on its own.
        // The regtest legs arm it explicitly rather than being dropped, because the
        // round trip is cadence arithmetic and regtest is the only cadence that
        // differs (30/12/2 against 1008/144/36), so dropping it would stop testing
        // the short-interval case entirely.
        it('round-trips a close block back to its epoch on an ARMED network', function () {
            const armed = loadWithEnv('armed');
            for (const [E, net] of [[30, 'regtest'], [60, 'regtest'], [151200, 'testnet']]) {
                const C = armed.rollcallCloseHeight(E, net);
                assert.strictEqual(armed.rollcallEpochClosingAt(C, net), E, net + ' close ' + C);
            }
        });

        it('returns null for a block where no epoch closes', function () {
            const armed = loadWithEnv('armed');
            assert.strictEqual(armed.rollcallEpochClosingAt(43, 'regtest'), null);
            assert.strictEqual(armed.rollcallEpochClosingAt(12345, 'regtest'), null);
        });

        it('never closes an epoch on an inert mainnet', function () {
            const C = act.rollcallCloseHeight(1008, 'mainnet');
            assert.strictEqual(typeof C, 'number', 'the arithmetic is still well-defined');
            assert.strictEqual(act.rollcallEpochClosingAt(C, 'mainnet'), null,
                'an inert network must never close an epoch, which is what keeps mainnet from evicting anyone');
        });

        it('fails closed on garbage rather than returning NaN', function () {
            assert.strictEqual(act.rollcallWindowEndHeight('abc', 'regtest'), null);
            assert.strictEqual(act.rollcallCloseHeight(30, 'bogusnet'), null);
            assert.strictEqual(act.rollcallEpochClosingAt('abc', 'regtest'), null);
        });
    });
});

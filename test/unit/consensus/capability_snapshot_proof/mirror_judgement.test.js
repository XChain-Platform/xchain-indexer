/*
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 */

'use strict';

const assert = require('assert');
const { judgeMirroredCapabilityRow } = require(
    '../../../../src/consensus/capability_snapshot_proof/mirror_judgement.js');

const TESTNET_PIN = 'CHECKPOINT_VALIDATORS_BTC_TESTNET';
const SIGNER = '1'.repeat(64);
const VALIDATOR = 'a'.repeat(64);
const row = {
    snapshot_block: 106,
    capability: 'oracle_publish',
    signing_pubkey: SIGNER,
    source: 'source-0',
    amount: '1',
};
const proof = {
    snapshot_block: 106,
    capability: 'oracle_publish',
    checkpoint: {},
    proof: {},
};

function readEnv(values){
    return name => values[name];
}

function pinnedOptions(overrides = {}){
    return Object.assign({
        network: 'testnet',
        fetchProof: async () => proof,
        readEnv: readEnv({
            [TESTNET_PIN]: JSON.stringify([
                { pubkey: VALIDATOR, weight: '1', source: 'source-0' },
            ]),
        }),
    }, overrides);
}

function verifier(verdict = 'verified', reason = null){
    return async () => ({ verdict, reason });
}

function assertHeld(actual, detail){
    assert.strictEqual(actual.verdict, 'held');
    assert.strictEqual(actual.firstUse, false);
    assert.strictEqual(typeof actual.reason, 'string');
    assert.match(actual.reason, detail);
}

describe('capability snapshot proof mirror judgement @regression @tier1', function () {
    it('holds when fetchProof or the verifier is missing', async function () {
        assertHeld(await judgeMirroredCapabilityRow(row, undefined, verifier()), /fetchProof/);
        assertHeld(await judgeMirroredCapabilityRow(row, {
            network: 'testnet',
            readEnv: readEnv({}),
        }, verifier()), /fetchProof/);
        assertHeld(await judgeMirroredCapabilityRow(row, pinnedOptions()), /verifier/);
    });

    it('holds fetch failures and missing proof responses', async function () {
        const throwing = pinnedOptions({
            fetchProof: async () => { throw new Error('HTTP 404'); },
        });
        assertHeld(await judgeMirroredCapabilityRow(row, throwing, verifier()), /HTTP 404/);

        const missing = pinnedOptions({ fetchProof: async () => null });
        assertHeld(await judgeMirroredCapabilityRow(row, missing, verifier()), /proof/);

        const malformed = pinnedOptions({ fetchProof: async () => 'proof' });
        assertHeld(await judgeMirroredCapabilityRow(row, malformed, verifier()), /proof/);
    });

    it('holds testnet with a missing or invalid trust pin', async function () {
        const missing = pinnedOptions({ readEnv: readEnv({}) });
        assertHeld(await judgeMirroredCapabilityRow(row, missing, verifier()),
            new RegExp(TESTNET_PIN));

        const invalid = pinnedOptions({
            readEnv: readEnv({ [TESTNET_PIN]: 'not json' }),
        });
        assertHeld(await judgeMirroredCapabilityRow(row, invalid, verifier()),
            new RegExp(TESTNET_PIN));
    });

    it('passes exact fetchProof and verifier arguments for a pinned row', async function () {
        const fetchCalls = [];
        const verifyCalls = [];
        const fetchProof = async (...args) => {
            fetchCalls.push(args);
            return proof;
        };
        const verifyProof = async (...args) => {
            verifyCalls.push(args);
            return { verdict: 'verified', reason: null };
        };

        const actual = await judgeMirroredCapabilityRow(
            row, pinnedOptions({ fetchProof }), verifyProof);

        assert.deepStrictEqual(actual, { verdict: 'verified', reason: null, firstUse: false });
        assert.deepStrictEqual(fetchCalls, [[106, 'oracle_publish', [SIGNER]]]);
        assert.strictEqual(verifyCalls.length, 1);
        assert.strictEqual(verifyCalls[0][0], row);
        assert.strictEqual(verifyCalls[0][1], proof);
        assert.deepStrictEqual(verifyCalls[0][2], [
            { pubkey: VALIDATOR, weight: '1', source: 'source-0' },
        ]);
        assert.deepStrictEqual(verifyCalls[0][3], { network: 'testnet', firstUse: false });
    });

    it('passes verified, refused, and held verifier verdicts through', async function () {
        assert.deepStrictEqual(await judgeMirroredCapabilityRow(
            row, pinnedOptions(), verifier('verified', null)),
        { verdict: 'verified', reason: null, firstUse: false });
        assert.deepStrictEqual(await judgeMirroredCapabilityRow(
            row, pinnedOptions(), verifier('refused', 'amount differs')),
        { verdict: 'refused', reason: 'amount differs', firstUse: false });
        assert.deepStrictEqual(await judgeMirroredCapabilityRow(
            row, pinnedOptions(), verifier('held', 'proof malformed')),
        { verdict: 'held', reason: 'proof malformed', firstUse: false });
    });

    it('marks unpinned regtest as first use with a null trust set', async function () {
        const calls = [];
        const verifyProof = async (...args) => {
            calls.push(args);
            return { verdict: 'verified', reason: null };
        };
        const options = {
            network: 'regtest',
            fetchProof: async () => proof,
            readEnv: readEnv({}),
        };

        assert.deepStrictEqual(await judgeMirroredCapabilityRow(row, options, verifyProof),
            { verdict: 'verified', reason: null, firstUse: true });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0][2], null);
        assert.deepStrictEqual(calls[0][3], { network: 'regtest', firstUse: true });
    });

    it('holds a throwing verifier and an unknown verifier verdict', async function () {
        const throwing = async () => { throw new Error('verifier boom'); };
        assertHeld(await judgeMirroredCapabilityRow(row, pinnedOptions(), throwing),
            /verifier boom/);
        assertHeld(await judgeMirroredCapabilityRow(
            row, pinnedOptions(), async () => ({ verdict: 'maybe' })), /verdict/);
    });

    it('uses process.env when readEnv is omitted', async function () {
        const saved = process.env[TESTNET_PIN];
        try {
            process.env[TESTNET_PIN] = JSON.stringify([
                { pubkey: VALIDATOR, weight: '1', source: 'source-0' },
            ]);
            const options = { network: 'testnet', fetchProof: async () => proof };
            assert.deepStrictEqual(await judgeMirroredCapabilityRow(row, options, verifier()),
                { verdict: 'verified', reason: null, firstUse: false });
        } finally {
            if(saved === undefined) delete process.env[TESTNET_PIN];
            else process.env[TESTNET_PIN] = saved;
        }
    });
});

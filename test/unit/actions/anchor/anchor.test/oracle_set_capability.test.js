// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Capability selection and memoization coverage for ANCHOR quorum verification.

'use strict';

const assert = require('assert');
const crypto = require('crypto');

const {
    verifyHeadQuorum,
    makeOracleSetResolver,
    verifySections,
} = require('../../../../../src/actions/anchor/quorum.js');

const NETWORK = 'mainnet';
const WEIGHTED_BLOCK = 961000;
const COUNT_BLOCK = 960000;
const CANONICAL = 'fixed anchor canonical';

function identity(){
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubkey = publicKey.export({ format: 'der', type: 'spki' })
        .subarray(12).toString('hex');
    return { privateKey, pubkey };
}

function signedBy(signer){
    return {
        pubkey: signer.pubkey,
        sig: crypto.sign(null, Buffer.from(CANONICAL, 'utf8'), signer.privateKey)
            .toString('hex'),
    };
}

function validator(signer, source = 'source-1', weight = '1'){
    return { pubkey: signer.pubkey, source, weight };
}

function fixture(rowsFor){
    const calls = [];
    const canonicalCalls = [];
    const handler = {
        indexerDb: {
            async getStakeWeightsByCapability(capability, block){
                calls.push(['getStakeWeightsByCapability', capability, block]);
                return rowsFor(capability, block, 'getStakeWeightsByCapability');
            },
            async getValidatorsByCapability(capability, block){
                calls.push(['getValidatorsByCapability', capability, block]);
                return rowsFor(capability, block, 'getValidatorsByCapability');
            },
        },
        canonical(value){
            canonicalCalls.push(value);
            return CANONICAL;
        },
    };
    return { handler, calls, canonicalCalls };
}

describe('ANCHOR oracle set capability routing @regression @tier1', function(){
    it('uses oracle_publish stake weights by default at the mainnet activation', async function(){
        const signer = identity();
        const { handler, calls } = fixture(() => [validator(signer)]);
        const data = { SNAPSHOT_BLOCK: WEIGHTED_BLOCK, NETWORK };

        const result = await verifyHeadQuorum(handler, data, [signedBy(signer)], null);

        assert.strictEqual(result.error, null);
        assert.deepStrictEqual(calls, [
            ['getStakeWeightsByCapability', 'oracle_publish', WEIGHTED_BLOCK],
        ]);
    });

    it('uses oracle_publish validator counts by default below the mainnet activation', async function(){
        const signer = identity();
        const { handler, calls } = fixture(() => [validator(signer)]);
        const data = { SNAPSHOT_BLOCK: COUNT_BLOCK, NETWORK };

        const result = await verifyHeadQuorum(handler, data, [signedBy(signer)], null);

        assert.strictEqual(result.error, null);
        assert.deepStrictEqual(calls, [
            ['getValidatorsByCapability', 'oracle_publish', COUNT_BLOCK],
        ]);
    });

    it('routes an explicit cross_chain capability to the snapshot read', async function(){
        const signer = identity();
        const { handler, calls } = fixture(() => [validator(signer)]);
        const data = { SNAPSHOT_BLOCK: WEIGHTED_BLOCK, NETWORK };

        const result = await verifyHeadQuorum(
            handler, data, [signedBy(signer)], null, 'cross_chain');

        assert.strictEqual(result.error, null);
        assert.deepStrictEqual(calls, [
            ['getStakeWeightsByCapability', 'cross_chain', WEIGHTED_BLOCK],
        ]);
    });

    it('stores unverified without an error when the selected set has zero rows', async function(){
        const { handler } = fixture(() => []);
        const data = { SNAPSHOT_BLOCK: WEIGHTED_BLOCK, NETWORK };

        const result = await verifyHeadQuorum(handler, data, [], null, 'cross_chain');

        assert.strictEqual(result.error, null);
        assert.strictEqual(data.STATUS, 'unverified');
    });

    it('does not count a valid signature from a key outside the selected set', async function(){
        const member = identity();
        const outsider = identity();
        const { handler } = fixture(() => [validator(member)]);
        const data = { SNAPSHOT_BLOCK: WEIGHTED_BLOCK, NETWORK };

        const result = await verifyHeadQuorum(
            handler, data, [signedBy(outsider)], null, 'cross_chain');

        assert.strictEqual(result.error, 'invalid: insufficient signer stake');
    });

    it("memoizes by capability while preserving each capability's own rows", async function(){
        const oracle = identity();
        const cross = identity();
        const { handler, calls } = fixture(capability => [
            validator(capability === 'cross_chain' ? cross : oracle),
        ]);
        const oracleSetFor = makeOracleSetResolver(handler);

        const first = await oracleSetFor(WEIGHTED_BLOCK, NETWORK);
        const repeated = await oracleSetFor(WEIGHTED_BLOCK, NETWORK);
        const other = await oracleSetFor(WEIGHTED_BLOCK, NETWORK, 'cross_chain');

        assert.strictEqual(repeated, first);
        assert.deepStrictEqual(first.validators, [validator(oracle)]);
        assert.deepStrictEqual(other.validators, [validator(cross)]);
        assert.deepStrictEqual([...first.snapPubkeys], [oracle.pubkey]);
        assert.deepStrictEqual([...other.snapPubkeys], [cross.pubkey]);
        assert.deepStrictEqual(calls, [
            ['getStakeWeightsByCapability', 'oracle_publish', WEIGHTED_BLOCK],
            ['getStakeWeightsByCapability', 'cross_chain', WEIGHTED_BLOCK],
        ]);
    });

    it('keeps network and block in the resolver memo key', async function(){
        const signer = identity();
        const { handler, calls } = fixture(() => [validator(signer)]);
        const oracleSetFor = makeOracleSetResolver(handler);

        await oracleSetFor(WEIGHTED_BLOCK, NETWORK);
        await oracleSetFor(WEIGHTED_BLOCK, 'testnet');
        await oracleSetFor(COUNT_BLOCK, NETWORK);

        assert.deepStrictEqual(calls, [
            ['getStakeWeightsByCapability', 'oracle_publish', WEIGHTED_BLOCK],
            ['getStakeWeightsByCapability', 'oracle_publish', WEIGHTED_BLOCK],
            ['getValidatorsByCapability', 'oracle_publish', COUNT_BLOCK],
        ]);
    });

    it('verifySections judges two same-block sections on one oracle_publish entry', async function(){
        const signer = identity();
        const { handler, calls, canonicalCalls } = fixture(() => [validator(signer)]);
        const oracleSetFor = makeOracleSetResolver(handler);
        const sig = signedBy(signer);
        const sections = [0, 1].map(SECTION_INDEX => ({
            SNAPSHOT_BLOCK: WEIGHTED_BLOCK,
            NETWORK,
            SECTION_INDEX,
            SIGS: [sig],
        }));
        const data = {};

        const result = await verifySections(handler, data, sections, oracleSetFor, null);

        assert.strictEqual(result.error, null);
        assert.strictEqual(data.STATUS, undefined);
        assert.deepStrictEqual(calls, [
            ['getStakeWeightsByCapability', 'oracle_publish', WEIGHTED_BLOCK],
        ]);
        assert.deepStrictEqual(canonicalCalls, sections);
    });
});

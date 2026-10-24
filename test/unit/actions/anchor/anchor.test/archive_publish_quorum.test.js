'use strict';

// Copyright (c) 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const crypto = require('crypto');
const sinon = require('sinon');

const archivePublish = require('../../../../../src/consensus/archive_publish_set.js');
const {
    verifyHeadQuorum,
    makeOracleSetResolver,
    verifySections,
} = require('../../../../../src/actions/anchor/quorum.js');

const NETWORK = 'regtest';
const BLOCK = 100;
const CANONICAL = 'archive quorum canonical';

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

function weightedRow(signer, index){
    return { pubkey: signer.pubkey, source: 'source-' + index, weight: '10' };
}

function fixture(present, absent){
    const calls = [];
    const sets = {
        archive_publish: present.map(weightedRow),
        oracle_publish: present.concat(absent).map(weightedRow),
    };
    const handler = {
        indexerDb: {
            async getStakeWeightsByCapability(capability, block){
                calls.push([capability, block]);
                return sets[capability];
            },
            async getValidatorsByCapability(){
                throw new Error('weighted fixture used the count path');
            },
        },
        canonical(){ return CANONICAL; },
    };
    return { handler, calls, sets };
}

function section(index, signer, archive){
    const value = {
        SNAPSHOT_BLOCK: BLOCK,
        NETWORK,
        SECTION_INDEX: index,
        SIGS: [signedBy(signer)],
    };
    if(archive !== undefined)
        Object.defineProperty(value, 'FOLD_ARCHIVE', { value: archive });
    return value;
}

afterEach(function(){ sinon.restore(); });

describe('ANCHOR archive_publish quorum routing @regression @tier1', function(){
    it('excludes an absent member from v1 N and S above the gate', async function(){
        sinon.stub(archivePublish, 'isArchivePublishSetActive').returns(true);
        const present = [identity(), identity()];
        const absent = [identity()];
        const { handler, calls, sets } = fixture(present, absent);
        const data = { SNAPSHOT_BLOCK: BLOCK, NETWORK };

        const result = await verifyHeadQuorum(
            handler, data, present.map(signedBy), null);

        assert.strictEqual(result.error, null);
        assert.strictEqual(sets.archive_publish.length, 2);
        assert.strictEqual(sets.archive_publish.reduce((sum, row) =>
            sum + Number(row.weight), 0), 20);
        assert.deepStrictEqual(calls, [['archive_publish', BLOCK]]);
    });

    it('counts the absent member in v1 N and S below the gate', async function(){
        sinon.stub(archivePublish, 'isArchivePublishSetActive').returns(false);
        const present = [identity(), identity()];
        const absent = [identity()];
        const { handler, calls, sets } = fixture(present, absent);
        const data = { SNAPSHOT_BLOCK: BLOCK, NETWORK };

        const result = await verifyHeadQuorum(
            handler, data, present.map(signedBy), null);

        assert.strictEqual(result.error, 'invalid: insufficient signer stake');
        assert.strictEqual(sets.oracle_publish.length, 3);
        assert.strictEqual(sets.oracle_publish.reduce((sum, row) =>
            sum + Number(row.weight), 0), 30);
        assert.deepStrictEqual(calls, [['oracle_publish', BLOCK]]);
    });

    it('judges only the v3 wrapper on archive_publish at the same block', async function(){
        sinon.stub(archivePublish, 'isArchivePublishSetActive').returns(true);
        const wrapperSigner = identity();
        const plainSigner = identity();
        const { handler, calls } = fixture([wrapperSigner], [plainSigner]);
        const archive = { WRAPPER_SECTION_INDEX: 0 };
        const sections = [
            section(0, wrapperSigner, archive),
            section(1, plainSigner, archive),
        ];
        sections[1].SIGS.unshift(signedBy(wrapperSigner));
        const data = {};

        const result = await verifySections(
            handler, data, sections, makeOracleSetResolver(handler), null);

        assert.strictEqual(result.error, null);
        assert.strictEqual(data.STATUS, undefined);
        assert.deepStrictEqual(calls, [
            ['archive_publish', BLOCK],
            ['oracle_publish', BLOCK],
        ]);
    });

    it('stores a post-gate v3 fold as unverified with zero archive_publish rows', async function(){
        sinon.stub(archivePublish, 'isArchivePublishSetActive').returns(true);
        const signer = identity();
        const { handler, calls } = fixture([], [signer]);
        const archive = { WRAPPER_SECTION_INDEX: 0 };
        const sections = [section(0, signer, archive), section(1, signer, archive)];
        const data = {};

        const result = await verifySections(
            handler, data, sections, makeOracleSetResolver(handler), null);

        assert.strictEqual(result.error, null);
        assert.strictEqual(data.STATUS, 'unverified');
        assert.deepStrictEqual(calls, [['archive_publish', BLOCK]]);
    });
});

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
 ********************************************************************/

'use strict';

const assert = require('assert');
const fixture = require('../../fixtures/anchor_canonical_vectors.json');
const { splitV3Wire } = require('../../../src/actions/anchor/v3_wire.js');

const SECTION_FIELDS = [
    'chain', 'block_index', 'block_hash', 'ledger_hash', 'actions_hash',
    'contract_hash', 'checkpoint_seq', 'snapshot_block', 'state_root',
    'state_root_version', 'block_merkle_root', 'block_merkle_version'
];
const ARCHIVE_FIELDS = [
    ['WRAPPER_SECTION_INDEX', 'wrapper_section_index'],
    ['MATCH_BATCH_SEQ', 'match_batch_seq'],
    ['MATCH_COUNT', 'match_count'],
    ['BATCH_CRC32', 'batch_crc32'],
    ['TOTAL_CHUNKS', 'total_chunks'],
    ['ARCHIVE_B64', 'archive_b64']
];

function paramsFor(name){
    return fixture.vectors[name].split('|').slice(1);
}

function expectedSection(section){
    const fields = SECTION_FIELDS.map((name) => String(section[name]));
    fields.push(String(section.validator_signatures.length));
    const signatures = [...section.validator_signatures].sort((a, b) => a.pubkey.localeCompare(b.pubkey));
    for(const signature of signatures)
        fields.push(signature.pubkey, signature.sig);
    return fields;
}

function expectedAttestationTail(bundle){
    const fields = [String(bundle.attest_sigs.length)];
    for(const signature of bundle.attest_sigs)
        fields.push(signature.pubkey, signature.sig);
    return fields;
}

function assertBundleFields(actual, bundle, archiveCount){
    assert.strictEqual(actual.header.NETWORK, bundle.network);
    assert.strictEqual(actual.header.SNAPSHOT_BLOCK, String(bundle.snapshot_block));
    assert.strictEqual(actual.header.SECTION_COUNT, String(bundle.sections.length));
    assert.strictEqual(actual.sections.length, bundle.sections.length);
    const wireSections = [...bundle.sections].sort((a, b) => a.chain.localeCompare(b.chain));
    wireSections.forEach((section, index) => {
        assert.deepStrictEqual(actual.sections[index], expectedSection(section));
    });
    assert.strictEqual(actual.ARCHIVE_COUNT, String(archiveCount));
    assert.strictEqual(actual.PUBLISHER, bundle.publisher);
    assert.deepStrictEqual(actual.attestationTail, expectedAttestationTail(bundle));
}

describe('ANCHOR v3 wire splitter', function () {
    it('splits the frozen archive-bearing vector field by field', function () {
        const bundle = fixture.fixture.bundle_v3;
        const actual = splitV3Wire(paramsFor('v3'));
        assertBundleFields(actual, bundle, bundle.archive_count);
        assert.ok(actual.archive);
        for(const [wireName, fixtureName] of ARCHIVE_FIELDS)
            assert.strictEqual(actual.archive[wireName], String(bundle[fixtureName]));
    });

    it('splits the frozen archive-free vector without consuming its publisher tail', function () {
        const bundle = Object.assign({}, fixture.fixture.bundle_v3_no_archive, {
            sections: fixture.fixture.bundle_v3.sections,
            attest_sigs: fixture.fixture.bundle_v3.attest_sigs
        });
        const actual = splitV3Wire(paramsFor('v3_no_archive'));
        assertBundleFields(actual, bundle, bundle.archive_count);
        assert.strictEqual(actual.archive, null);
    });

    it('refuses ARCHIVE_COUNT 2', function () {
        const params = paramsFor('v3');
        const archiveCountIndex = paramsFor('v3_no_archive').length - 7;
        params[archiveCountIndex] = '2';
        assert.deepStrictEqual(splitV3Wire(params), { error: 'invalid: ARCHIVE_COUNT' });
    });

    it('refuses a wrapper index outside the section range', function () {
        const params = paramsFor('v3');
        const archiveCountIndex = paramsFor('v3_no_archive').length - 7;
        params[archiveCountIndex + 1] = params[3];
        assert.deepStrictEqual(splitV3Wire(params), { error: 'invalid: WRAPPER_SECTION_INDEX' });
    });

    it('accepts SECTION_COUNT 0 without trying to read a chain section', function () {
        const publisher = fixture.fixture.bundle_v3.publisher;
        const actual = splitV3Wire(['3', 'regtest', '100', '0', '0', publisher, '0']);
        assert.deepStrictEqual(actual.sections, []);
        assert.strictEqual(actual.header.SECTION_COUNT, '0');
        assert.strictEqual(actual.archive, null);
    });

    it('refuses archive fields when ARCHIVE_COUNT is 0', function () {
        const params = paramsFor('v3');
        const archiveCountIndex = paramsFor('v3_no_archive').length - 7;
        params[archiveCountIndex] = '0';
        assert.deepStrictEqual(splitV3Wire(params), { error: 'invalid: ARCHIVE_COUNT' });
    });

    it('refuses missing archive fields when ARCHIVE_COUNT is 1', function () {
        const params = paramsFor('v3_no_archive');
        const archiveCountIndex = params.length - 7;
        params[archiveCountIndex] = '1';
        assert.deepStrictEqual(splitV3Wire(params), { error: 'invalid: ARCHIVE_COUNT' });
    });
});

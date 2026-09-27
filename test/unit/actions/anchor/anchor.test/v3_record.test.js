// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const observability = require('../../../../../src/observability/index.js');
const diag = require('../../../../../src/actions/anchor/diagnostic_events.js');
const { recordFoldAction } = require('../../../../../src/actions/anchor/v3/v3_record.js');

function actionData(){
    return {
        FORMAT: 3,
        NETWORK: 'regtest',
        SNAPSHOT_BLOCK: '900',
        SECTION_COUNT: 2,
        BLOCK_INDEX: 1234,
        PUBLISHER: 'a'.repeat(64)
    };
}

function section(chain, index){
    return {
        CHAIN: chain,
        BLOCK_INDEX_CHECKPOINTED: String(500 + index),
        CHECKPOINT_SEQ: String(index),
        SIGS: [{ pubkey: chain + '-validator', sig: chain + '-signature' }]
    };
}

function archiveData(){
    return {
        WRAPPER_SECTION_INDEX: 1,
        MATCH_BATCH_SEQ: '72',
        MATCH_COUNT: '4',
        BATCH_CRC32: 'deadbeef',
        TOTAL_CHUNKS: '1',
        ARCHIVE_B64: 'archive_payload'
    };
}

function recorder(){
    let rows = [];
    return {
        handler: { indexerDb: { createAnchorAction: async row => rows.push(row) } },
        rows
    };
}

describe('ANCHOR v3 recorder', function () {
    let noteAnchorFailed;
    let info;

    beforeEach(function () {
        noteAnchorFailed = sinon.stub(diag, 'noteAnchorFailed');
        info = sinon.stub(observability.getLogger(), 'info');
    });

    afterEach(function () {
        sinon.restore();
    });

    it('writes section rows followed by an archive row with wrapper signatures', async function () {
        const { handler, rows } = recorder();
        const data = actionData();
        const sections = [section('BTC', 0), section('DOGE', 1)];
        const publisherSigs = [{ pubkey: 'publisher', sig: 'attestation' }];

        await recordFoldAction(handler, data, sections, archiveData(), publisherSigs, null);

        assert.deepStrictEqual(rows.map(row => row.SECTION_INDEX), [0, 1, 2]);
        assert.strictEqual(rows[2].VALIDATOR_SIGNATURES, JSON.stringify(sections[1].SIGS));
        assert.ok(rows.every(row => row.PUBLISHER_ATTESTATIONS === JSON.stringify(publisherSigs)));
        assert.ok(rows.every(row => row.STATUS === 'valid'));
        assert.ok(info.calledOnce);
        assert.match(info.firstCall.args[0], /^ANCHOR v3 : regtest @ snapshot 900/);
        assert.match(info.firstCall.args[0], /ARCHIVE_COUNT 1/);
    });

    it('writes only section rows when the archive is null', async function () {
        const { handler, rows } = recorder();
        const data = actionData();
        const sections = [section('BTC', 0), section('DOGE', 1)];

        await recordFoldAction(handler, data, sections, null, [], null);

        assert.deepStrictEqual(rows.map(row => row.SECTION_INDEX), [0, 1]);
        assert.ok(rows.every(row => row.PUBLISHER_ATTESTATIONS === null));
        assert.match(info.firstCall.args[0], /ARCHIVE_COUNT 0/);
    });

    it('puts an error status on every row and reports one failure', async function () {
        const { handler, rows } = recorder();
        const data = actionData();
        const sections = [section('BTC', 0), section('DOGE', 1)];
        const error = 'invalid: archive mismatch';

        await recordFoldAction(handler, data, sections, archiveData(), [], error);

        assert.ok(rows.every(row => row.STATUS === error));
        assert.ok(noteAnchorFailed.calledOnce);
        assert.deepStrictEqual(noteAnchorFailed.firstCall.args[0], {
            chain: 'BTC,DOGE',
            reason: error,
            network: 'regtest',
            version: 3,
            snapshot_block: '900',
            block_index: 1234
        });
    });

    it('writes one row at section index zero without sections or an archive', async function () {
        const { handler, rows } = recorder();
        const data = actionData();
        data.SECTION_COUNT = 0;

        await recordFoldAction(handler, data, [], null, [], null);

        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].SECTION_INDEX, 0);
        assert.strictEqual(rows[0].STATUS, 'valid');
    });
});

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const observability = require('../../../../../src/observability/index.js');
const diag = require('../../../../../src/actions/anchor/diagnostic_events.js');
const { reportArchiveFailure } = require('../../../../../src/actions/anchor/archive/archive_verdict.js');

function stubHandler(withRowStatus = true) {
    const calls = { action: [], row: [] };
    const indexerDb = {
        setAnchorArchiveStatus: async (...args) => calls.action.push(args)
    };
    if (withRowStatus) {
        indexerDb.setAnchorArchiveRowStatus = async (...args) => calls.row.push(args);
    }
    return { handler: { indexerDb }, calls };
}

function failure(overrides = {}) {
    return Object.assign({
        logLine: 'archive validation failed',
        event: { chain: 'BTC', reason: 'invalid_archive: mismatch' },
        actionIndex: 41
    }, overrides);
}

describe('archive failure reporter', function () {
    let noteAnchorFailed;
    let warn;

    beforeEach(function () {
        noteAnchorFailed = sinon.stub(diag, 'noteAnchorFailed');
        warn = sinon.stub(observability.getLogger(), 'warn');
    });

    afterEach(function () {
        sinon.restore();
    });

    it('stamps only the action-wide archive status before section scoping', async function () {
        const { handler, calls } = stubHandler();

        await reportArchiveFailure(handler, failure(), false);

        assert.deepStrictEqual(calls.action, [[41, 'invalid_archive']]);
        assert.deepStrictEqual(calls.row, []);
    });

    it('stamps only the archive row status when section scoped', async function () {
        const { handler, calls } = stubHandler();

        await reportArchiveFailure(handler, failure(), true);

        assert.deepStrictEqual(calls.action, []);
        assert.deepStrictEqual(calls.row, [[41, 'invalid_archive']]);
    });

    it('throws instead of falling back when the row status method is missing', async function () {
        const { handler, calls } = stubHandler(false);

        await assert.rejects(
            reportArchiveFailure(handler, failure(), true),
            /setAnchorArchiveRowStatus/
        );

        assert.deepStrictEqual(calls.action, []);
        assert.deepStrictEqual(calls.row, []);
    });

    it('passes the event object unchanged to the diagnostic emitter', async function () {
        const { handler } = stubHandler();
        const event = { chain: 'LTC', reason: 'invalid_archive: CRC mismatch' };

        await reportArchiveFailure(handler, failure({ event }), false);

        assert.ok(noteAnchorFailed.calledOnceWithExactly(event));
        assert.strictEqual(noteAnchorFailed.firstCall.args[0], event);
        assert.ok(warn.calledOnceWithExactly('archive validation failed'));
    });

    it('converts a string action index to a number before stamping', async function () {
        const { handler, calls } = stubHandler();

        await reportArchiveFailure(handler, failure({ actionIndex: '73' }), true);

        assert.deepStrictEqual(calls.row, [[73, 'invalid_archive']]);
        assert.strictEqual(typeof calls.row[0][0], 'number');
    });
});

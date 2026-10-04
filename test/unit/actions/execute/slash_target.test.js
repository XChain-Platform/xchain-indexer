// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const { resolveSlashTarget } = require('../../../../src/actions/execute/slash_target.js');

const CONTRACT_INDEX = 41;
const PUBKEY = 'ABCDEF';

function makeContext(overrides = {}) {
    return {
        indexerDb: {
            getContract: sinon.stub().resolves({ slash_destination_id: 9 }),
            getPubkeyId: sinon.stub().resolves(17),
            getTickerId: sinon.stub().resolves(23),
            ...overrides,
        },
    };
}

function emission(overrides = {}) {
    return {
        params: {
            contractIndex: CONTRACT_INDEX,
            pubkey: PUBKEY,
            token: 'STK',
            ...overrides,
        },
    };
}

const data = () => ({ CONTRACT_ACTION_INDEX: CONTRACT_INDEX });

describe('resolveSlashTarget result', function () {
    it('returns the resolved target and defaults amount to zero', async function () {
        const context = makeContext();
        const result = await resolveSlashTarget.call(context, emission(), data());

        assert.deepStrictEqual(result, {
            contractIndex: CONTRACT_INDEX,
            pubkey: 'abcdef',
            token: 'STK',
            amount: '0',
            contractInfo: { slash_destination_id: 9 },
            pubkeyId: 17,
            tickId: 23,
        });
        assert.ok(context.indexerDb.getContract.calledWithExactly(CONTRACT_INDEX));
        assert.ok(context.indexerDb.getPubkeyId.calledWithExactly('abcdef'));
        assert.ok(context.indexerDb.getTickerId.calledWithExactly('STK'));
    });
});

describe('resolveSlashTarget contract validation', function () {
    it('rejects a contract index mismatch before lookup', async function () {
        const context = makeContext();
        await assert.rejects(
            resolveSlashTarget.call(context, emission({ contractIndex: 42 }), data()),
            (error) => error.message.startsWith('SLASH emission contractIndex mismatch'));
        assert.ok(context.indexerDb.getContract.notCalled);
    });

    it('rejects a missing contract', async function () {
        const context = makeContext({ getContract: sinon.stub().resolves(null) });
        await assert.rejects(
            resolveSlashTarget.call(context, emission(), data()),
            { message: 'SLASH: contract not found: 41' });
    });
});

describe('resolveSlashTarget slash destination validation', function () {
    for(const slashDestinationId of [null, undefined]) {
        it('rejects a slash destination set to ' + String(slashDestinationId), async function () {
            const getContract = sinon.stub().resolves({ slash_destination_id: slashDestinationId });
            const context = makeContext({ getContract });
            await assert.rejects(
                resolveSlashTarget.call(context, emission(), data()),
                { message: 'SLASH: contract has no slash destination configured' });
        });
    }
});

describe('resolveSlashTarget no-op results', function () {
    it('returns null for an unknown pubkey without looking up the token', async function () {
        const context = makeContext({ getPubkeyId: sinon.stub().resolves(null) });
        const result = await resolveSlashTarget.call(context, emission(), data());

        assert.strictEqual(result, null);
        assert.ok(context.indexerDb.getTickerId.notCalled);
    });

    it('returns null for an unknown token', async function () {
        const context = makeContext({ getTickerId: sinon.stub().resolves(null) });
        const result = await resolveSlashTarget.call(context, emission(), data());

        assert.strictEqual(result, null);
    });
});

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
const sinon = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Address = require('../../../src/actions/address.js');

describe('Address action handler @regression @tier3', function () {
    let indexer, actionsCtx, handler;

    beforeEach(function () {
        indexer = createMockIndexer();
        actionsCtx = {
            config: indexer.config,
            util: indexer.util,
            mapper: indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: indexer.indexerDb,
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
            processAction: sinon.stub().resolves(),
        };
        handler = new Address(actionsCtx);
        indexer.util.resetLists();
    });

    function makeParams(feePreference, requireMemo, memo, dispenserPreference) {
        return [
            '0',
            String(feePreference),
            String(requireMemo),
            dispenserPreference !== undefined ? String(dispenserPreference) : '',
            memo !== undefined ? memo : '',
        ];
    }

    it('accepts FEE_PREFERENCE=0', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, ''), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('accepts FEE_PREFERENCE=1', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(1, 0, ''), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('accepts FEE_PREFERENCE=2', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(2, 0, ''), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('rejects FEE_PREFERENCE=3 as invalid value', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(3, 0, ''), data, null);
        assert.ok(data['STATUS'].includes('FEE_PREFERENCE'), `Expected FEE_PREFERENCE error, got: ${data['STATUS']}`);
    });

    it('rejects FEE_PREFERENCE=5 (out of valid range)', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        const params = ['0', '5', '0', '', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('FEE_PREFERENCE'), `Expected FEE_PREFERENCE error, got: ${data['STATUS']}`);
    });

    it('accepts REQUIRE_MEMO=0', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, ''), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('accepts REQUIRE_MEMO=1', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 1, ''), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('rejects REQUIRE_MEMO=2 as invalid value', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 2, ''), data, null);
        assert.ok(data['STATUS'].includes('REQUIRE_MEMO'), `Expected REQUIRE_MEMO error, got: ${data['STATUS']}`);
    });

    it('accepts DISPENSER_PREFERENCE=1', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, '', 1), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('accepts DISPENSER_PREFERENCE=2', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, '', 2), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('rejects DISPENSER_PREFERENCE=0 as invalid value', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, '', 0), data, null);
        assert.ok(data['STATUS'].includes('DISPENSER_PREFERENCE'), `Expected DISPENSER_PREFERENCE error, got: ${data['STATUS']}`);
    });

    it('rejects DISPENSER_PREFERENCE=3 (out of valid range)', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, '', 3), data, null);
        assert.ok(data['STATUS'].includes('DISPENSER_PREFERENCE'), `Expected DISPENSER_PREFERENCE error, got: ${data['STATUS']}`);
    });

    it('rejects non-numeric DISPENSER_PREFERENCE', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        const params = ['0', '0', '0', 'abc', ''];
        await handler.parse(params, data, null);
        assert.ok(data['STATUS'].includes('DISPENSER_PREFERENCE'), `Expected DISPENSER_PREFERENCE format error, got: ${data['STATUS']}`);
    });

    it('accepts blank DISPENSER_PREFERENCE (preserves prior preference)', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, ''), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
    });

    it('rejects MEMO containing a pipe character', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, 'bad|memo'), data, null);
        assert.ok(data['STATUS'].includes('MEMO'), `Expected MEMO error, got: ${data['STATUS']}`);
    });

    it('rejects MEMO containing a semicolon', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, 'bad;memo'), data, null);
        assert.ok(data['STATUS'].includes('MEMO'), `Expected MEMO error, got: ${data['STATUS']}`);
    });

    it('rejects MEMO exceeding MAX_MEMO_LENGTH', async function () {
        const longMemo = 'x'.repeat(indexer.config['MAX_MEMO_LENGTH'] + 1);
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, longMemo), data, null);
        assert.ok(data['STATUS'].includes('MEMO'), `Expected MEMO length error, got: ${data['STATUS']}`);
    });

    it('rejects when SOURCE is sleeping', async function () {
        indexer.indexerDb.isActionAllowed.resolves(false);
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, ''), data, null);
        assert.ok(data['STATUS'].includes('SOURCE'), `Expected SOURCE sleeping error, got: ${data['STATUS']}`);
    });

    it('calls createAddressOption on the indexerDb', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, 'hello'), data, null);
        assert.ok(indexer.indexerDb.createAddressOption.calledOnce);
    });

    it('calls mapper.createMappings after parse', async function () {
        const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 0 });
        await handler.parse(makeParams(0, 0, ''), data, null);
        assert.ok(indexer.mapper.createMappings.calledOnce);
    });

    /*****************************************************************
     *  / D-154: a REFUSED format 1 (controller bind) was silent.
     *
     * Format 1 used to persist nothing but the address_controllers event, and that
     * write only runs when the action is valid, so a refused bind wrote no row
     * anywhere and its verdict existed solely in a console.log line: by every
     * client it was indistinguishable from an action not yet processed. Format 1
     * now writes the same `addresses` audit row every other ADDRESS writes (the
     * contract issue.js has always had), while the enforcement log still takes
     * valid events only.
     ****************************************************************/
    describe('format 1 : controller bind persistence', function () {
        // VERSION|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO
        function bindParams({ controller = '1500', actionClass = 'transfer', cooldown = '144', unbind = '', memo = '' } = {}) {
            return ['1', String(controller), String(actionClass), String(cooldown), String(unbind), memo];
        }

        beforeEach(function () {
            // A bind validates its CONTROLLER against an existing, active contract.
            indexer.indexerDb.getContract      = sinon.stub().resolves({ action_index: 1500, status_id: 1 });
            indexer.indexerDb.getStatusString  = sinon.stub().resolves('valid');
            indexer.indexerDb.getAddressId     = sinon.stub().resolves(7);
            indexer.indexerDb.createAddress    = sinon.stub().resolves(7);
        });

        it('a valid bind writes both the audit row and the controller event', async function () {
            const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 1, ACTION_INDEX: 1787 });
            await handler.parse(bindParams(), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createAddressOption.calledOnce, 'the addresses audit row is written');
            assert.ok(indexer.indexerDb.recordAddressControllerEvent.calledOnce, 'the binding is appended');
            const evt = indexer.indexerDb.recordAddressControllerEvent.firstCall.args[0];
            assert.strictEqual(evt.action_index, 1787);
            assert.strictEqual(evt.action_class, 'transfer');
            assert.strictEqual(evt.contract_index, '1500');
            assert.strictEqual(evt.is_unbind, 0);
            assert.strictEqual(evt.cooldown_blocks, 144);
        });

        it('the audit row carries the verdict, not preferences', async function () {
            const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 1, ACTION_INDEX: 1787 });
            await handler.parse(bindParams({ memo: 'gate my transfers' }), data, null);
            const written = indexer.indexerDb.createAddressOption.firstCall.args[0];
            assert.strictEqual(written['STATUS'], 'valid');
            assert.strictEqual(written['MEMO'], 'gate my transfers');
            // A v1 sets no preferences at all, so every preference column is written NULL.
            // Number(NULL) is 0, which is why getAddressPreferences excludes the format
            // outright rather than trusting the columns.
            assert.strictEqual(written['FEE_PREFERENCE'], null);
            assert.strictEqual(written['REQUIRE_MEMO'], null);
            assert.strictEqual(written['DISPENSER_PREFERENCE'], null);
        });

        it('a REFUSED bind still writes its audit row, and binds nothing', async function () {
            // A controller already gates this class, which is the exact refusal the
            // ledger entry names as unreadable.
            indexer.indexerDb.getEffectiveAddressController.resolves({
                action_index: 1700, contract_index: 1500, is_unbind: 0, cooldown_blocks: 144, cooldown_end_block: null
            });
            const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 1, ACTION_INDEX: 1790 });
            await handler.parse(bindParams(), data, null);
            assert.strictEqual(data['STATUS'], 'invalid: ACTION_CLASS (already bound)');
            assert.ok(indexer.indexerDb.createAddressOption.calledOnce, 'a refused bind is readable');
            const written = indexer.indexerDb.createAddressOption.firstCall.args[0];
            assert.strictEqual(written['STATUS'], 'invalid: ACTION_CLASS (already bound)');
            assert.ok(indexer.indexerDb.recordAddressControllerEvent.notCalled,
                'the enforcement log must never carry a refused bind');
        });

        it('a REFUSED unbind is readable too', async function () {
            const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 1, ACTION_INDEX: 1791 });
            await handler.parse(bindParams({ controller: '', unbind: '1' }), data, null);
            assert.strictEqual(data['STATUS'], 'invalid: ACTION_CLASS (not bound)');
            assert.ok(indexer.indexerDb.createAddressOption.calledOnce);
            assert.ok(indexer.indexerDb.recordAddressControllerEvent.notCalled);
        });

        it('an unknown ACTION_CLASS is readable rather than silent', async function () {
            const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 1, ACTION_INDEX: 1792 });
            await handler.parse(bindParams({ actionClass: 'teleport' }), data, null);
            assert.strictEqual(data['STATUS'], 'invalid: ACTION_CLASS (unknown)');
            const written = indexer.indexerDb.createAddressOption.firstCall.args[0];
            assert.strictEqual(written['STATUS'], 'invalid: ACTION_CLASS (unknown)');
            assert.ok(indexer.indexerDb.recordAddressControllerEvent.notCalled);
        });

        it('a valid unbind appends the drop and its cooldown end block', async function () {
            indexer.indexerDb.getEffectiveAddressController.resolves({
                action_index: 1700, contract_index: 1500, is_unbind: 0, cooldown_blocks: 144, cooldown_end_block: null
            });
            const data = createBaseData({ ACTION: 'ADDRESS', FORMAT: 1, ACTION_INDEX: 1801, BLOCK_INDEX: 900 });
            await handler.parse(bindParams({ controller: '', unbind: '1' }), data, null);
            assert.strictEqual(data['STATUS'], 'valid');
            assert.ok(indexer.indexerDb.createAddressOption.calledOnce);
            const evt = indexer.indexerDb.recordAddressControllerEvent.firstCall.args[0];
            assert.strictEqual(evt.is_unbind, 1);
            assert.strictEqual(evt.cooldown_blocks, 144);
            assert.strictEqual(evt.cooldown_end_block, 1044);
        });
    });
});

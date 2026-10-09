/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const valueChecks = require('../../../src/utility/validation/value_checks.js');
const ProtocolChanges = require('../../../src/protocol_changes.js');
const orderValidation = require('../../../src/actions/order/validate.js');
const swapValidation = require('../../../src/actions/swap/validate.js');
const dispenserValidation = require('../../../src/actions/dispenser/validate_format.js');
const betCreateValidation = require('../../../src/actions/bet/create_feed.js');
const betValidation = require('../../../src/actions/bet/validate.js');

const exactUtil = Object.assign({
    isNull(value){ return value === null || value === undefined || value === ''; },
}, valueChecks);

function protocolChanges(enabled){
    return { isEnabled: async (name) => {
        assert.strictEqual(name, 'EXACT_INTEGER_WIRE_FIELDS');
        return enabled;
    } };
}

function baseHandler(enabled){
    return {
        actions: { protocolChanges: protocolChanges(enabled) },
        config: { LIST_FIELDS: [], INTEGER_FIELDS: { EXPIRATION: '18446744073709551615' } },
        util: exactUtil,
        indexerDb: { isActionAllowed: async () => true },
    };
}

describe('exact integer wire fields @regression @tier1', function(){
    it('accepts only lossless integer representations', function(){
        for(let value of ['0', '-1', '+2', '18446744073709551615', 7, 7n, { isInteger: () => true }])
            assert.strictEqual(valueChecks.isExactInteger(value), true, String(value));
        for(let value of ['', '1.0', '1e3', ' 1', 1.5, Number.MAX_SAFE_INTEGER + 1, null, { isInteger: () => false }])
            assert.strictEqual(valueChecks.isExactInteger(value), false, String(value));
    });

    it('registers the protocol change unarmed on every network', function(){
        const row = ProtocolChanges.get('protocol_changes.changes.EXACT_INTEGER_WIRE_FIELDS');
        assert.strictEqual(row.mainnet_time, ProtocolChanges.UNARMED);
        assert.strictEqual(row.testnet_time, ProtocolChanges.UNARMED);
        assert.strictEqual(row.regtest_time, ProtocolChanges.UNARMED);
    });

    it('gates ORDER and SWAP integer wire spellings', async function(){
        for(const [validation, field] of [[orderValidation, 'ORDER_ACTION_INDEX'], [swapValidation, 'SWAP_ACTION_INDEX']]){
            const handler = baseHandler(true);
            const data = { BLOCK_INDEX: 8, BLOCK_TIME: 10, SOURCE: 'source', MEMO: null, [field]: '1e3' };
            const st = { data, format: 1, error: null, orderInfo: { SOURCE: 'source', ORDER_STATUS: 'open' },
                swapInfo: { SOURCE: 'source', SWAP_STATUS: 'open' } };
            await validation.validateGeneral(handler, st);
            assert.strictEqual(st.error, 'invalid: ' + field + ' (format)');

            st.error = null;
            handler.actions.protocolChanges = protocolChanges(false);
            await validation.validateGeneral(handler, st);
            assert.strictEqual(st.error, null);
        }
    });

    it('gates DISPENSER integer wire spellings', async function(){
        const handler = baseHandler(true);
        Object.assign(handler, dispenserValidation);
        const ctx = { data: { BLOCK_INDEX: 8, EXPIRATION: '1.0' }, error: null, format: 0, getTokenInfo: false };
        await handler.validateAddressAndExpirationFields(ctx);
        assert.strictEqual(ctx.error, 'invalid: EXPIRATION (format)');

        ctx.error = null;
        handler.actions.protocolChanges = protocolChanges(false);
        await handler.validateAddressAndExpirationFields(ctx);
        assert.strictEqual(ctx.error, null);
    });

    it('gates BET create and existing-feed integer wire spellings', async function(){
        const handler = baseHandler(true);
        Object.assign(handler, betCreateValidation, betValidation);
        handler.validateFeedDefinition = async (data, tokenInfo, labels, error) => error;
        handler.validateFeedTerms = (data, tokenInfo, error) => error;
        handler.validateFeedGating = async (data, labels, error) => error;

        let error = await handler.validateCreateFeed({ BLOCK_INDEX: 8, DEADLINE: '1e3' }, 0, {}, [], null);
        assert.strictEqual(error, 'invalid: DEADLINE (format)');

        error = await handler.validateFeedState({ BLOCK_INDEX: 8, FEED_ACTION_INDEX: '1.0' }, 1,
            { SOURCE: 'source', FEED_STATUS: 'open' }, null);
        assert.strictEqual(error, 'invalid: FEED_ACTION_INDEX (format)');

        handler.actions.protocolChanges = protocolChanges(false);
        error = await handler.validateCreateFeed({ BLOCK_INDEX: 8, DEADLINE: '1e3' }, 0, {}, [], null);
        assert.strictEqual(error, null);
    });
});

/*
 * ISSUE MINT_START_BLOCK / MINT_STOP_BLOCK against their VARCHAR(15) columns.
 *
 * A wire value wider than the column must never reach a bind that MariaDB refuses with
 * errno 1406. A valid row that would overflow is refused with a length verdict before any
 * write, and a refused row that does reach the writer is clipped to the column.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const tokenState     = require('../../../../../src/actions/issue/token_state.js');
const { buildIssue } = require('./helpers/fixture.js');
const { strictDb }   = require('../../../db/text_width/helpers/strict_db.js');

const WIDE_VALUES = ['18446744073709551615', '18446744073709551615.4', '1.8446744073709551615e19'];
const COLUMNS     = [['MINT_START_BLOCK', 'mint_start_block'], ['MINT_STOP_BLOCK', 'mint_stop_block']];

function verdictFor(field, value){
    const { handler } = buildIssue();
    const issue = { [field]: value };
    const ctx = { data: Object.assign({}, issue), issue: Object.assign({}, issue),
                  tokenInfo: null, cbInfo: false, error: null };
    tokenState.validateFieldFormats.call(handler, ctx);
    return ctx.error;
}

afterEach(function () {
    sinon.restore();
});

describe('ISSUE mint block columns fit their VARCHAR(15) @regression', function () {
    for(const [field, column] of COLUMNS){
        for(const value of WIDE_VALUES){
            it(field + ' ' + value + ' on a valid action is refused with a length verdict', function () {
                assert.strictEqual(verdictFor(field, value), 'invalid: ' + field + ' (length)');
            });

            it(column + ' ' + value + ' on a refused row is clipped so the insert cannot throw 1406', async function () {
                const { db, inserts } = strictDb();
                await db.createIssue({ ACTION: 'ISSUE', ACTION_INDEX: 9, STATUS: 'invalid: ' + field + ' (length)',
                                       TICK: 'T', [field]: value });
                const row = inserts.issues;
                assert.ok(row, 'no INSERT INTO issues');
                assert.ok(String(row[column]).length <= 15, column + ' bound ' + String(row[column]).length + ' chars');
            });
        }

        it(field + ' of exactly 15 characters is accepted and stored unchanged', async function () {
            const value = '9'.repeat(15);
            assert.strictEqual(verdictFor(field, value), null);
            const { db, inserts } = strictDb();
            await db.createIssue({ ACTION: 'ISSUE', ACTION_INDEX: 9, STATUS: 'valid', TICK: 'T', [field]: value });
            assert.strictEqual(inserts.issues[column], value);
        });
    }
});

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/bridge/db_xbridge_writers.test/handler_end_to_end.test.js
 *
 * The REAL XBRIDGE handler run into the REAL writers, so the payload the handler
 * builds and the columns the writer binds are proven to line up rather than
 * assumed to. The entry file db_xbridge_writers.test.js carries the writer cases
 * each side is tested by on its own.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockDb, createBaseData, createTokenInfo } = require('../../../fixtures/mocks');
const Utility  = require('../../../../src/utility.js');
const configjs = require('../../../../src/config.js');
const XBridge  = require('../../../../src/actions/xbridge/index.js');
const { SOURCE, DEST, BRIDGE_DOGE, makeTable, makeDb } = require('./helpers/writer_db.js');

// The real handler over a mock read-side db, with the two WRITERS bound to a real
// Database over the table simulator. This is what proves the handler's payload and
// the writer's column binding agree; each side tested alone can be self-consistent
// and still disagree with the other.
function setup(){
    const config = configjs.getConfig('BTC', 'regtest');
    config['ADDRESS']['BRIDGE_DOGE']       = BRIDGE_DOGE;
    config['GAS_SCHEDULE']['XBRIDGE_BASE'] = 5000;

    const util      = new Utility(config);
    const indexerDb = createMockDb();
    const xbridges  = makeTable('xbridges', ['action_index']);
    const tokens    = makeTable('tokens', ['tick_id']);
    const ids       = { tick: { FUFU: 101 } };
    const realDb    = makeDb([xbridges, tokens], ids);
    tokens.rows.push({ tick_id: 101, bridged: 0 });

    indexerDb.createXbridge   = (data) => realDb.createXbridge(data);
    indexerDb.setTokenBridged = (tick, block) => realDb.setTokenBridged(tick, block);
    indexerDb.getTokenInfo.resolves(createTokenInfo({
        TICK: 'FUFU', TICK_ID: 7, DECIMALS: 2, OWNER: SOURCE,
        BRIDGE_CHAINS: 'DOGE', MIN_DEPTH: 3
    }));
    indexerDb.getAddressBalances.resolves({ 7: '100', 1: '100' });

    const handler = new XBridge({
        config, util, indexerDb,
        decoderDb: createMockDb(),
        mapper:    { createMappings: sinon.stub().resolves() },
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true)
        }
    });
    util.resetLists();
    return { handler, xbridges, tokens, ids };
}

describe('XBRIDGE handler into the real writers, end to end @regression', function(){
    afterEach(() => sinon.restore());

    it('a valid v3 lock leaves an xbridges row and a set bridged bit', async function(){
        const { handler, xbridges, tokens, ids } = setup();
        const data = createBaseData({
            ACTION: 'XBRIDGE', FORMAT: 3, COIN: 'BTC', SOURCE: SOURCE,
            BLOCK_INDEX: 100, ACTION_INDEX: 42, TX_OUTPUTS: []
        });
        await handler.parse(['3', 'FUFU', 'DOGE', DEST, '5.25', ''], data, null);

        assert.strictEqual(data['STATUS'], 'valid', 'the lock itself must apply');
        assert.strictEqual(xbridges.rows.length, 1);
        const row = xbridges.rows[0];
        assert.strictEqual(row.action_index, 42);
        assert.strictEqual(row.version,      3);
        assert.strictEqual(row.tick_id,      ids.tick['FUFU']);
        assert.strictEqual(row.dest_chain,   'DOGE');
        assert.strictEqual(row.amount,       '5.25');
        assert.strictEqual(row.decimals,     2);
        assert.strictEqual(row.min_depth,    3);
        assert.strictEqual(row.block_index,  100);
        assert.strictEqual(tokens.rows[0].bridged, 1, 'the first applied v3 sets the bit');
    });
});

describe('XBRIDGE handler into the real writers, end to end @regression', function(){
    afterEach(() => sinon.restore());

    it('a refused v3 still leaves its row and never sets the bridged bit', async function(){
        const { handler, xbridges, tokens } = setup();
        const data = createBaseData({
            ACTION: 'XBRIDGE', FORMAT: 3, COIN: 'BTC', SOURCE: SOURCE,
            BLOCK_INDEX: 100, ACTION_INDEX: 43, TX_OUTPUTS: []
        });
        // XCHAIN keeps v0, so a v3 naming the GAS tick is refused before any effect.
        await handler.parse(['3', 'XCHAIN', 'DOGE', DEST, '5', ''], data, null);

        assert.strictEqual(data['STATUS'], 'invalid: TICK (use XBRIDGE v0)');
        assert.strictEqual(xbridges.rows.length, 1, 'the refusal is recorded');
        assert.strictEqual(xbridges.rows[0].dest_chain, null);
        assert.strictEqual(tokens.rows[0].bridged, 0, 'a refused lock must never set the bit');
    });
});

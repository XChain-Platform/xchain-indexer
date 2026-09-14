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
 * test/unit/db_xbridge_writers.test/token_bridged.test.js
 *
 * setTokenBridged(), the second XBRIDGE writer: the origin row's sticky
 * tokens.bridged bit. The entry file db_xbridge_writers.test.js carries why each
 * case asserts the resulting row rather than the SQL text.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { makeTable, makeDb } = require('./helpers/writer_db.js');

describe('setTokenBridged() - the sticky tokens.bridged bit @regression', function(){

    afterEach(() => sinon.restore());

    function setup(){
        const tokens = makeTable('tokens', ['tick_id']);
        const ids    = { tick: { FUFU: 101, OTHER: 102 } };
        const db     = makeDb([tokens], ids);
        tokens.rows.push({ tick_id: 101, bridged: 0 });
        tokens.rows.push({ tick_id: 102, bridged: 0 });
        return { tokens, db };
    }

    it('sets the bit on the locked token and on nothing else', async function(){
        const { tokens, db } = setup();
        await db.setTokenBridged('FUFU', 500);

        assert.deepStrictEqual(tokens.rows.map(r => [r.tick_id, r.bridged]), [[101, 1], [102, 0]]);
    });

    it('is a no-op for every later lock of the same token', async function(){
        const { tokens, db } = setup();
        await db.setTokenBridged('FUFU', 500);
        const logged = sinon.stub(console, 'log');
        await db.setTokenBridged('FUFU', 900);
        const secondLockLogged = logged.callCount;
        logged.restore();

        assert.strictEqual(tokens.rows[0].bridged, 1, 'the bit stays set');
        assert.strictEqual(secondLockLogged, 0, 'the WHERE must exclude an already-set bit');
    });

    it('writes nothing for a tick that has no row on this chain', async function(){
        const { tokens, db } = setup();
        await db.setTokenBridged('NOSUCH', 500);

        assert.deepStrictEqual(tokens.rows.map(r => r.bridged), [0, 0]);
    });
});

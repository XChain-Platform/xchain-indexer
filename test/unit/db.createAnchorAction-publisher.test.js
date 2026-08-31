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
 * test/unit/db.createAnchorAction-publisher.test.js
 *
 * (indexer-only): createAnchorAction must persist the v6/v7 publisher-attestation
 * tail (data['PUBLISHER'] + data['PUBLISHER_ATTESTATIONS']) into the nullable
 * publisher / publisher_attestations columns, and leave both NULL for the versions
 * that carry no tail. anchor_actions is a derived local table (NOT consensus-visible).
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');

// Column order in the INSERT arg array (0-based), up to the publisher tail.
// section_index leads the list (it is the second half of the primary key and sits
// right after action_index in the definition), so every later index is one past
// where it sat before ANCHOR v7.
const IDX_SECTION_INDEX          = 0;
const IDX_VALIDATOR_SIGNATURES   = 21;
const IDX_PUBLISHER              = 22;
const IDX_PUBLISHER_ATTESTATIONS = 23;

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
}

// Drive createAnchorAction with doQuery stubbed and capture the INSERT statement.
async function runCreate(db, data) {
    sinon.stub(db, 'createStatus').resolves(7);
    const doQuery = sinon.stub(db, 'doQuery');
    doQuery.onFirstCall().resolves([]);   // exists probe: not present -> INSERT path
    doQuery.resolves();                    // the INSERT
    await db.createAnchorAction(data);
    const insert = doQuery.getCalls().find(c => /INSERT INTO anchor_actions/.test(c.args[0]));
    assert.ok(insert, 'expected an INSERT INTO anchor_actions');
    return { sql: insert.args[0], args: insert.args[1] };
}

const PUB  = 'ab'.repeat(32); // 64-hex publisher pubkey
const ATT  = [{ pubkey: 'cd'.repeat(32), sig: 'ef'.repeat(64) }];

describe('createAnchorAction publisher tail', function () {

    afterEach(() => sinon.restore());

    it('INSERT names the new publisher / publisher_attestations columns', async function () {
        const db = makeDb();
        const { sql } = await runCreate(db, { ACTION_INDEX: 1, FORMAT: 1, STATUS: 'valid', BLOCK_INDEX: 100 });
        assert.match(sql, /publisher\b/);
        assert.match(sql, /publisher_attestations\b/);
        assert.match(sql, /section_index\b/);
    });

    it('v7: persists PUBLISHER and the pre-serialized PUBLISHER_ATTESTATIONS JSON string', async function () {
        const db = makeDb();
        const pre = JSON.stringify(ATT); // anchor.js pre-serializes, same as VALIDATOR_SIGNATURES
        const { args } = await runCreate(db, {
            ACTION_INDEX: 2, FORMAT: 7, SECTION_INDEX: 1, STATUS: 'valid', BLOCK_INDEX: 101,
            PUBLISHER: PUB, PUBLISHER_ATTESTATIONS: pre
        });
        assert.strictEqual(args[IDX_SECTION_INDEX], 1,
            'a v7 section row lands at its own section_index, not always 0');
        assert.strictEqual(args[IDX_PUBLISHER], PUB);
        assert.strictEqual(args[IDX_PUBLISHER_ATTESTATIONS], pre,
            'attestations stored as-is, the JSON string anchor.js supplies (like validator_signatures)');
    });

    it('v6: passes a pre-serialized PUBLISHER_ATTESTATIONS string through unchanged', async function () {
        const db = makeDb();
        const pre = JSON.stringify(ATT);
        const { args } = await runCreate(db, {
            ACTION_INDEX: 3, FORMAT: 6, STATUS: 'valid', BLOCK_INDEX: 102,
            PUBLISHER: PUB, PUBLISHER_ATTESTATIONS: pre
        });
        assert.strictEqual(args[IDX_PUBLISHER], PUB);
        assert.strictEqual(args[IDX_PUBLISHER_ATTESTATIONS], pre);
    });

    it('v1/v2: both publisher columns are NULL, and the row lands at section 0', async function () {
        for (const FORMAT of [1, 2]) {
            const db = makeDb();
            const { args } = await runCreate(db, { ACTION_INDEX: 10 + FORMAT, FORMAT, STATUS: 'valid', BLOCK_INDEX: 200 });
            assert.strictEqual(args[IDX_PUBLISHER], null, 'v' + FORMAT + ' publisher NULL');
            assert.strictEqual(args[IDX_PUBLISHER_ATTESTATIONS], null, 'v' + FORMAT + ' attestations NULL');
            assert.strictEqual(args[IDX_SECTION_INDEX], 0,
                'a single-body version writes section 0, the column DEFAULT old writers also land on');
            sinon.restore();
        }
    });

    it('publisher tail sits right after validator_signatures (column order)', async function () {
        const db = makeDb();
        const { args } = await runCreate(db, {
            ACTION_INDEX: 4, FORMAT: 7, STATUS: 'valid', BLOCK_INDEX: 103,
            VALIDATOR_SIGNATURES: '[]', PUBLISHER: PUB, PUBLISHER_ATTESTATIONS: JSON.stringify(ATT)
        });
        assert.strictEqual(args[IDX_VALIDATOR_SIGNATURES], '[]');
        assert.strictEqual(args[IDX_PUBLISHER], PUB);
    });
});

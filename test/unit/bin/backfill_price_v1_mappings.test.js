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
 **********************************************************************
 * test/unit/bin/backfill_price_v1_mappings.test.js
 *
 * Drives bin/backfill-price-v1-mappings.js's runBackfill against a stubbed DB (no
 * real database, local, regtest or live, is ever touched): a real Database instance
 * whose `pool` is stubbed unused and whose `doQuery` is replaced with an in-memory
 * fake over `prices`, `index_addresses` and `mappings_actions`. Real Utility and
 * Mapper classes run on top of it, so the test exercises the SAME addAddressTicker +
 * createMappings path 9fed3912 wired into the live parser, not a re-implementation
 * of it.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../../fixtures/config');
const Utility  = require('../../../src/utility');
const Database = require('../../../src/db');
const Mapper   = require('../../../src/chain/mapper.js');
const { runBackfill } = require('../../../bin/backfill-price-v1-mappings.js');

// A minimal in-memory backend behind db.doQuery: just enough of prices,
// index_addresses and mappings_actions to drive the real createAddress /
// createActionMappings code paths without a real database.
function makeFakeBackend(priceRows){
    let addressIds = {}; // address -> id (every SOURCE already has a resolved id, matching
                          // reality: the row was written by createPrice at parse time)
    let nextId = 1;
    for(let row of priceRows){
        if(!addressIds[row.source_address])
            addressIds[row.source_address] = nextId++;
    }
    let mappingsActions = []; // { action_index, type_id, id }

    async function doQuery(sql, args){
        args = args || [];

        // Our own backfill lookup (price_v1_mapping_backfill.js). The version-1 filter
        // is read OFF THE SQL TEXT, not hard-coded here: if the real query ever drops
        // its `p.version = 1` predicate, this fake stops filtering too, and a v0 row
        // leaks into the result exactly as a real un-filtered query would return it.
        if(/FROM\s+prices\s+p/i.test(sql) && /NOT EXISTS/i.test(sql)){
            let filtersToVersion1 = /p\.version\s*=\s*1\b/i.test(sql);
            return priceRows
                .filter(row => !filtersToVersion1 || row.version === 1)
                .filter(row => {
                    let id = addressIds[row.source_address];
                    return !mappingsActions.some(m => m.action_index === row.action_index && m.type_id === 2 && m.id === id);
                })
                .map(row => ({
                    action_index:   row.action_index,
                    source_id:      addressIds[row.source_address],
                    source_address: row.source_address
                }));
        }

        // db/index_tables/addresses.js getAddressId: resolve an existing address.
        if(/SELECT id FROM index_addresses WHERE `address`=\?/i.test(sql)){
            let id = addressIds[args[0]];
            return (id === undefined) ? [] : [{ id: id }];
        }

        // db/mappings/index.js createActionMappings: existing-row de-dup probe.
        if(/SELECT id FROM mappings_actions WHERE action_index=\? AND type_id=\? AND id IN/i.test(sql)){
            let [action_index, type_id, ...ids] = args;
            return mappingsActions
                .filter(m => m.action_index === action_index && m.type_id === type_id && ids.includes(m.id))
                .map(m => ({ id: m.id }));
        }

        // db/mappings/index.js createActionMappings: the batched multi-row INSERT.
        if(/INSERT INTO mappings_actions/i.test(sql)){
            for(let i = 0; i < args.length; i += 3)
                mappingsActions.push({ action_index: args[i], type_id: args[i + 1], id: args[i + 2] });
            return { affectedRows: args.length / 3 };
        }

        throw new Error('fake backend: unhandled query: ' + sql);
    }

    return { doQuery, mappingsActions, addressIds };
}

function makeStubbedDb(priceRows){
    let config  = getTestConfig();
    let util    = new Utility(config);
    let indexer = { config: config, util: util };
    let db      = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    db.pool = { getConnection: sinon.stub().resolves({ query: sinon.stub().resolves([]), release: sinon.stub().resolves() }) };

    let backend = makeFakeBackend(priceRows);
    sinon.stub(db, 'doQuery').callsFake(backend.doQuery);

    let mapper = new Mapper({ config: config, util: util, indexerDb: db, decoderDb: null });

    return { db, util, mapper, backend };
}

afterEach(function(){ sinon.restore(); });

const PRICE_ROWS = [
    // A valid v1 oracle price with no mapping row yet (the 9fed3912 gap).
    { action_index: 101, version: 1, validation_status: 'valid', source_address: '1SourceValidAAAAAAAAAAAAAAAAAAAAAA' },
    // A rejected (invalid) v1 quote: 9fed3912 stages SOURCE for these too.
    { action_index: 102, version: 1, validation_status: 'invalid', source_address: '1SourceInvalidBBBBBBBBBBBBBBBBBBBB' },
];

describe('bin/backfill-price-v1-mappings @regression @tier3', function(){

    it('dry run prints the planned rows and writes nothing', async function(){
        let { db, util, mapper, backend } = makeStubbedDb(PRICE_ROWS);

        let candidates = await runBackfill({ db: db, util: util, mapper: mapper, apply: false });

        assert.strictEqual(candidates.length, 2);
        assert.deepStrictEqual(candidates.map(c => c.actionIndex).sort(), [101, 102]);
        assert.ok(candidates.some(c => c.actionIndex === 102),
            'an invalid v1 quote (validation_status=invalid) must still be a candidate');
        assert.strictEqual(backend.mappingsActions.length, 0, 'dry run must not write mappings_actions');
    });

    it('--apply writes exactly the missing mappings', async function(){
        let { db, util, mapper, backend } = makeStubbedDb(PRICE_ROWS);

        let candidates = await runBackfill({ db: db, util: util, mapper: mapper, apply: true });

        assert.strictEqual(candidates.length, 2);
        assert.strictEqual(backend.mappingsActions.length, 2, 'exactly the two missing address mappings are written');
        for(let row of PRICE_ROWS){
            let id = backend.addressIds[row.source_address];
            assert.ok(
                backend.mappingsActions.some(m => m.action_index === row.action_index && m.type_id === 2 && m.id === id),
                'expected a mapping row for action_index ' + row.action_index
            );
        }
    });

    it('a second --apply is a no-op', async function(){
        let { db, util, mapper, backend } = makeStubbedDb(PRICE_ROWS);

        await runBackfill({ db: db, util: util, mapper: mapper, apply: true });
        assert.strictEqual(backend.mappingsActions.length, 2);

        let secondPass = await runBackfill({ db: db, util: util, mapper: mapper, apply: true });

        assert.strictEqual(secondPass.length, 0, 'nothing left unmapped after the first apply');
        assert.strictEqual(backend.mappingsActions.length, 2, 'the second apply wrote no additional rows');
    });
});

describe('bin/backfill-price-v1-mappings, v0 validator rounds @regression @tier3', function(){

    const V0_ROWS = [
        { action_index: 101, version: 1, validation_status: 'valid', source_address: '1SourceValidAAAAAAAAAAAAAAAAAAAAAA' },
        // A v0 validator round: 9fed3912 never wires SOURCE into addAddressTicker for
        // these (only v1 does), so it has no mapping row either. A regression that
        // dropped the `version = 1` filter would pick this up as if it were a gap.
        { action_index: 199, version: 0, validation_status: 'valid', source_address: '1SourceValidatorRoundDDDDDDDDDDDDD' },
    ];

    it('never treats a v0 validator round as a candidate, in dry run or --apply', async function(){
        let { db, util, mapper, backend } = makeStubbedDb(V0_ROWS);

        let dryRun = await runBackfill({ db: db, util: util, mapper: mapper, apply: false });
        assert.deepStrictEqual(dryRun.map(c => c.actionIndex), [101], 'the v0 round must not be a dry-run candidate');

        let applied = await runBackfill({ db: db, util: util, mapper: mapper, apply: true });
        assert.deepStrictEqual(applied.map(c => c.actionIndex), [101]);

        let v0Id = backend.addressIds['1SourceValidatorRoundDDDDDDDDDDDDD'];
        assert.ok(!backend.mappingsActions.some(m => m.id === v0Id),
            'a v0 validator round SOURCE must get no mapping row from this tool');
        assert.strictEqual(backend.mappingsActions.length, 1, 'only the v1 row was mapped');
    });
});

describe('bin/backfill-price-v1-mappings, already-mapped rows @regression @tier3', function(){

    it('leaves an already-mapped PRICE v1 SOURCE alone', async function(){
        let rows = PRICE_ROWS.concat([
            { action_index: 103, version: 1, source_address: '1SourceAlreadyMappedCCCCCCCCCCCCCC' },
        ]);
        let { db, util, mapper, backend } = makeStubbedDb(rows);
        // Pre-seed the mapping for action_index 103 exactly as the live parser would have.
        backend.mappingsActions.push({ action_index: 103, type_id: 2, id: backend.addressIds['1SourceAlreadyMappedCCCCCCCCCCCCCC'] });

        let candidates = await runBackfill({ db: db, util: util, mapper: mapper, apply: true });

        assert.deepStrictEqual(candidates.map(c => c.actionIndex).sort(), [101, 102]);
        assert.strictEqual(backend.mappingsActions.length, 3, 'the pre-existing mapping plus the two backfilled ones');
    });
});

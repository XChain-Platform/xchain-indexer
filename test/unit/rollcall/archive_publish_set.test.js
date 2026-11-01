/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const archivePublish = require('../../../src/consensus/archive_publish_set.js');
const gateRegistry = require('../../../src/consensus/gate_registry.js');
const swq = require('../../../src/consensus/stake_weighted_quorum.js');
const rollcalls = require('../../../src/db/rollcalls/index.js');

function weights(){
    return [
        { pubkey: 'key-a1', source: 'source-a', weight: '70' },
        { pubkey: 'key-a2', source: 'source-a', weight: '70' },
        { pubkey: 'key-b', source: 'source-b', weight: '30' },
    ];
}

function dbFor(base, absent){
    return {
        getStakeWeightsByCapability: sinon.stub().resolves(base),
        getLatestRolledRollcallAbsentSources: sinon.stub().resolves(absent),
    };
}

afterEach(function(){ sinon.restore(); });

describe('archive_publish roll-call presence set @regression @tier1', function(){
    it('returns oracle_publish weights minus every key of an absent source', async function(){
        let base = weights();
        let db = dbFor(base, ['source-a']);
        let result = await archivePublish.getArchivePublishSet(db, 100, 'regtest');

        assert.deepStrictEqual(result, [base[2]]);
        assert.deepStrictEqual(db.getStakeWeightsByCapability.firstCall.args,
            ['oracle_publish', 100]);
        assert.deepStrictEqual(db.getLatestRolledRollcallAbsentSources.firstCall.args, [100]);
    });

    it('returns the full oracle_publish set when no rolled epoch has closed', async function(){
        let base = weights();
        let db = dbFor(base, []);
        let result = await archivePublish.getArchivePublishSet(db, 100, 'regtest');

        assert.strictEqual(result, base);
    });

    it('returns the full oracle_publish set when the rolled epoch subtraction is empty', async function(){
        let base = weights();
        let db = dbFor(base, ['source-not-in-the-oracle-set']);
        let result = await archivePublish.getArchivePublishSet(db, 100, 'regtest');

        assert.strictEqual(result, base);
        assert.strictEqual(result.length, 3);
    });

    it('carries truncated through when absent sources are subtracted', async function(){
        let base = weights();
        base.truncated = true;
        let result = await archivePublish.getArchivePublishSet(
            dbFor(base, ['source-a']), 100, 'regtest');

        assert.deepStrictEqual(Array.from(result), [base[2]]);
        assert.strictEqual(result.truncated, true);
    });

    it('does not read roll-call absences while the archive_publish rule is inactive', async function(){
        let base = weights();
        let db = dbFor(base, ['source-a']);
        let result = await archivePublish.getArchivePublishSet(db, 100, 'mainnet');

        assert.strictEqual(result, base);
        assert.strictEqual(db.getLatestRolledRollcallAbsentSources.callCount, 0);
    });

    it('needs both its registry gate and stake-weighted quorum active', function(){
        sinon.stub(gateRegistry, 'activeAt').returns(true);
        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        assert.strictEqual(archivePublish.isArchivePublishSetActive(100, 'regtest'), false);
        assert.strictEqual(gateRegistry.activeAt.callCount, 0,
            'the archive gate cannot arm a count-quorum set');

        swq.isStakeWeightedQuorumActive.returns(true);
        assert.strictEqual(archivePublish.isArchivePublishSetActive(100, 'regtest'), true);
        assert.deepStrictEqual(gateRegistry.activeAt.firstCall.args, [
            archivePublish.ARCHIVE_ROLLCALL_PRESENCE_KEY,
            'regtest', 'BTC', 100, null,
        ]);

        gateRegistry.activeAt.returns(false);
        assert.strictEqual(archivePublish.isArchivePublishSetActive(100, 'regtest'), false);
    });
});

describe('latest rolled roll-call absent-source read @regression @tier1', function(){
    it('selects E* by close_block at or below the requested block and ignores an unrolled later epoch', async function(){
        let calls = [];
        let db = {
            doQueryStrict: sinon.stub().callsFake(async function(query, args){
                calls.push({ query, args });
                return [{ source: 'source-a' }];
            }),
        };

        let result = await rollcalls.getLatestRolledRollcallAbsentSources.call(db, 500);
        assert.deepStrictEqual(result, ['source-a']);
        assert.deepStrictEqual(calls[0].args, [500]);
        assert.match(calls[0].query, /WHERE r\.rolled = 1 AND r\.close_block <= \?/);
        assert.match(calls[0].query,
            /ORDER BY r\.close_block DESC, r\.epoch_height DESC\s+LIMIT 1/);
        assert.doesNotMatch(calls[0].query, /ORDER BY r\.epoch_height DESC\s+LIMIT 1/,
            'a later epoch must not replace E* unless its rolled close is applicable');
    });

    it('uses doQueryStrict so a read fault throws instead of becoming no closed epoch', async function(){
        let fault = new Error('roll-call read fault');
        let db = {
            doQuery: sinon.stub().resolves([]),
            doQueryStrict: sinon.stub().rejects(fault),
        };

        await assert.rejects(
            () => rollcalls.getLatestRolledRollcallAbsentSources.call(db, 500),
            (error) => error === fault);
        assert.strictEqual(db.doQuery.callCount, 0);
        assert.strictEqual(db.doQueryStrict.callCount, 1);
    });
});

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Token bridge policy reads, as the API serves them:
 * the "as of a block" read-path resolvers
 * (getListAtBlock, isTickSleepingAtBlock), gettokenpolicy / getappliedpolicy, and
 * the XPOLICY canonical membership hash.
 *
 * src/api.js calls startApi() at module load and cannot be required, so the
 * bridgePolicyHash function and the controller/gating checks are a static source
 * extraction, the api_state_root_version_boundary.test.js technique: compile and
 * run the REAL shipped function body, never a hand-copied paraphrase of it.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const sinon  = require('sinon');

const { getTestConfig } = require('../../fixtures/config');
const Utility  = require('../../../src/utility');
const Database = require('../../../src/db');

const { readApiSource } = require('../../helpers/api_source');
const API_SRC = readApiSource();

function newDb(){
    const config = getTestConfig();
    const util   = new Utility();
    sinon.stub(util, 'logError');
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', { config, util });
}

afterEach(function(){ sinon.restore(); });

// ── api.js registration: the policy reads are open ────────────────────────

describe('policy reads are registered open (token-bridge-policy spec D15) @regression @tier1', function(){
    const OPEN_METHODS = ['gettokenpolicy', 'getappliedpolicy'];

    function parseSet(name){
        const m = API_SRC.match(new RegExp('const\\s+' + name + '\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)'));
        assert.ok(m, name + ' not found in src/api.js');
        const names = [];
        const re = /['"]([a-z0-9_]+)['"]/gi;
        let hit;
        while((hit = re.exec(m[1])) !== null) names.push(hit[1]);
        return names;
    }

    const writeMethods     = parseSet('WRITE_METHODS');
    const gatedExecMethods = parseSet('GATED_EXEC_METHODS');
    const federationReads  = parseSet('FEDERATION_READ_METHODS');

    for(const name of OPEN_METHODS){
        it(name + ' is registered as a controller handler', function(){
            assert.match(API_SRC, new RegExp('\\n {8}async\\s+' + name + '\\s*\\('),
                name + ' handler not found in the jsonRpcController object');
        });
        it(name + ' is in none of WRITE_METHODS / GATED_EXEC_METHODS / FEDERATION_READ_METHODS', function(){
            assert.ok(!writeMethods.includes(name));
            assert.ok(!gatedExecMethods.includes(name));
            assert.ok(!federationReads.includes(name));
        });
    }
});

// ── bridgePolicyHash: the real shipped function, extracted and run ──────────

describe('bridgePolicyHash (policy spec section 5, D5, D7) @regression @tier1', function(){
    function loadBridgePolicyHash(){
        const start = API_SRC.indexOf('function bridgePolicyHash');
        assert.ok(start !== -1, 'bridgePolicyHash not found in src/api.js');
        let depth = 0, open = API_SRC.indexOf('{', start), end = -1;
        for(let i = open; i < API_SRC.length; i++){
            if(API_SRC[i] === '{') depth++;
            else if(API_SRC[i] === '}' && --depth === 0){ end = i + 1; break; }
        }
        assert.ok(end !== -1, 'could not brace-match bridgePolicyHash');
        const src = API_SRC.slice(start, end);
        // eslint-disable-next-line no-new-func
        const factory = new Function('crypto', src + '\nreturn bridgePolicyHash;');
        return factory(crypto);
    }

    const bridgePolicyHash = loadBridgePolicyHash();

    it('"-" marks an ABSENT list, distinct from an empty one (D7)', function(){
        const expected = crypto.createHash('sha256').update('ALLOW|-|BLOCK|-|SLEEP|0').digest('hex');
        assert.strictEqual(bridgePolicyHash(null, null, false), expected);
    });

    it('"0" marks an EXISTING but empty list (D7)', function(){
        const expected = crypto.createHash('sha256').update('ALLOW|0|BLOCK|-|SLEEP|0').digest('hex');
        assert.strictEqual(bridgePolicyHash([], null, false), expected);
        assert.notStrictEqual(bridgePolicyHash([], null, false), bridgePolicyHash(null, null, false),
            'an empty list must hash differently than an absent one');
    });

    it('carries addresses in the order handed to it (D5: getListAtBlock already sorts utf8_bin ascending)', function(){
        const expected = crypto.createHash('sha256')
            .update('ALLOW|-|BLOCK|2|addrA|addrB|SLEEP|1').digest('hex');
        assert.strictEqual(bridgePolicyHash(null, ['addrA', 'addrB'], true), expected);
    });

    it('FALSIFICATION: reordering the same two addresses changes the hash (never re-sorts)', function(){
        const h1 = bridgePolicyHash(null, ['addrA', 'addrB'], true);
        const h2 = bridgePolicyHash(null, ['addrB', 'addrA'], true);
        assert.notStrictEqual(h1, h2);
    });
});

// ── db.getListAtBlock ─────────────────────────────────────────────────────────

describe('db.getListAtBlock (policy spec D3) @regression @tier1', function(){
    it('below the edit-resolution flag, resolves the immutable create-time root (legacy read)', async function(){
        const db = newDb();
        sinon.stub(db, 'getListType').resolves(2);
        sinon.stub(db, 'getListRootIndex').resolves(11);
        sinon.stub(db, 'isListEditResolutionActive').returns(false);
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake(async (query, args) => {
            calls.push({ query, args });
            return [{ item: 'addrX' }];
        });
        const list = await db.getListAtBlock(11, 500);
        assert.deepStrictEqual(list, ['addrX']);
        assert.strictEqual(calls.length, 1, 'must skip the bounded head query entirely below the flag');
        assert.deepStrictEqual(calls[0].args, [11], 'must read list_items off the ROOT, not a resolved head');
    });

    it('above the flag, bounds the head to the last action index AT block_index (never the tip)', async function(){
        const db = newDb();
        sinon.stub(db, 'getListType').resolves(2);
        sinon.stub(db, 'getListRootIndex').resolves(11);
        sinon.stub(db, 'isListEditResolutionActive').returns(true);
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake(async (query, args) => {
            calls.push({ query, args });
            if(/FROM\s+lists l/i.test(query)){
                assert.match(query, /a\.block_index<=\?/, 'head query must bound by block_index');
                assert.deepStrictEqual(args, [11, 500]);
                return [{ action_index: 77 }];
            }
            return [{ item: 'addrY' }];
        });
        const list = await db.getListAtBlock(11, 500);
        assert.deepStrictEqual(list, ['addrY']);
        assert.strictEqual(calls.length, 2);
        assert.deepStrictEqual(calls[1].args, [77], 'list_items must be read off the BOUNDED head, not the root');
    });

    it('type 1 (TICK list) orders by a binary-collated tick, type 2 by a binary-collated address', async function(){
        const db = newDb();
        sinon.stub(db, 'getListRootIndex').resolves(1);
        sinon.stub(db, 'isListEditResolutionActive').returns(false);
        sinon.stub(db, 'doQuery').resolves([]);

        sinon.stub(db, 'getListType').resolves(1);
        await db.getListAtBlock(1, 10);
        assert.match(db.doQuery.getCall(0).args[0], /ORDER BY t\.tick COLLATE utf8mb4_bin ASC/);

        db.getListType.resolves(2);
        await db.getListAtBlock(1, 10);
        assert.match(db.doQuery.getCall(1).args[0], /ORDER BY a\.address COLLATE utf8_bin ASC/);
    });

    it('returns [] when the action_index names no list at all', async function(){
        const db = newDb();
        sinon.stub(db, 'getListType').resolves(false);
        const list = await db.getListAtBlock(999, 10);
        assert.deepStrictEqual(list, []);
    });
});

// ── db.isTickSleepingAtBlock ──────────────────────────────────────────────────

describe('db.isTickSleepingAtBlock (policy spec D3) @regression @tier1', function(){
    it('bounds the sleep row by block_index, unlike isTickSleeping', async function(){
        const db = newDb();
        sinon.stub(db, 'createTicker').resolves(5);
        sinon.stub(db, 'doQuery').callsFake(async (query, args) => {
            assert.match(query, /INNER JOIN actions\s+a1/i, 'must join actions to bound by block_index');
            assert.match(query, /a1\.block_index<=\?/);
            assert.deepStrictEqual(args, [2, 5, 'valid', 300]);
            return [{ resume_block: 400 }]; // sleeping until 400, asked as of 300
        });
        const sleeping = await db.isTickSleepingAtBlock('FUFU', 300);
        assert.strictEqual(sleeping, true);
    });

    it('a resume_block at or before the queried height reads as NOT sleeping', async function(){
        const db = newDb();
        sinon.stub(db, 'createTicker').resolves(5);
        sinon.stub(db, 'doQuery').resolves([{ resume_block: 100 }]);
        const sleeping = await db.isTickSleepingAtBlock('FUFU', 300);
        assert.strictEqual(sleeping, false);
    });

    it('resume_block -1 means indefinite sleep', async function(){
        const db = newDb();
        sinon.stub(db, 'createTicker').resolves(5);
        sinon.stub(db, 'doQuery').resolves([{ resume_block: -1 }]);
        const sleeping = await db.isTickSleepingAtBlock('FUFU', 300);
        assert.strictEqual(sleeping, true);
    });

    it('no sleep row at all means not sleeping', async function(){
        const db = newDb();
        sinon.stub(db, 'createTicker').resolves(5);
        sinon.stub(db, 'doQuery').resolves([]);
        const sleeping = await db.isTickSleepingAtBlock('FUFU', 300);
        assert.strictEqual(sleeping, false);
    });
});

// ── db.getAppliedPolicySnapshot ───────────────────────────────────────────────

describe('db.getAppliedPolicySnapshot (policy spec D25) @regression @tier1', function(){
    it('resolves the highest applied snapshot on a separate mirror handle', async function(){
        const db = newDb();
        const ids = ['a'.repeat(64), 'b'.repeat(64)];
        sinon.stub(db, 'doQuery').callsFake(async (query, args) => {
            assert.match(query, /FROM\s+bridge_settlements/i);
            assert.match(query, /bs\.kind='policy'/i);
            assert.doesNotMatch(query, /policy_snapshots/i,
                'the local ledger query cannot join a table held by the mirror connection');
            assert.deepStrictEqual(args, ['FUFU']);
            return ids.map(transfer_id => ({ transfer_id }));
        });
        const mirror = {
            doQuery: sinon.stub().callsFake(async (query, args) => {
                assert.match(query, /FROM\s+policy_snapshots/i);
                assert.doesNotMatch(query, /bridge_settlements/i,
                    'the mirror query cannot join a table held by the local ledger connection');
                assert.match(query, /network\s*=\s*\?/i);
                assert.match(query, /origin_chain\s*=\s*\?/i);
                assert.match(query, /tick\s*=\s*\?/i);
                assert.match(query, /snapshot_id\s+IN\s*\(\?,\?\)/i);
                assert.match(query, /ORDER BY\s+policy_seq DESC,\s*id DESC/i);
                assert.deepStrictEqual(args, ['regtest', 'DOGE', 'FUFU'].concat(ids));
                return [{ policy_seq: 3, origin_block: 900, policy_hash: 'h'.repeat(64) }];
            })
        };
        db.indexer.hubDb = mirror;

        const applied = await db.getAppliedPolicySnapshot('DOGE', 'FUFU');
        assert.strictEqual(applied.policy_seq, 3);
        assert.strictEqual(db.doQuery.callCount, 1);
        assert.strictEqual(mirror.doQuery.callCount, 1);
    });

    it('uses network, origin and native tick to reject another copy with a higher sequence', async function(){
        const db = newDb();
        const localId = 'c'.repeat(64);
        sinon.stub(db, 'doQuery').resolves([{ transfer_id: localId }]);
        const mirror = {
            doQuery: sinon.stub().callsFake(async (query, args) => {
                assert.match(query, /network\s*=\s*\?\s+AND\s+origin_chain\s*=\s*\?\s+AND\s+tick\s*=\s*\?/i);
                assert.deepStrictEqual(args, ['regtest', 'DOGE', 'FUFU', localId]);
                // The database applies the query predicates before ordering. This row is
                // the highest matching copy, not a higher sequence for another origin.
                return [{ policy_seq: 4, origin_block: 901, policy_hash: 'i'.repeat(64) }];
            })
        };
        db.indexer.hubDb = mirror;

        const applied = await db.getAppliedPolicySnapshot('DOGE', 'FUFU');
        assert.strictEqual(applied.policy_seq, 4);
    });

    it('returns null without consulting the mirror when nothing has applied here yet', async function(){
        const db = newDb();
        sinon.stub(db, 'doQuery').resolves([]);
        const mirror = { doQuery: sinon.stub().rejects(new Error('mirror must not be read')) };
        db.indexer.hubDb = mirror;
        const applied = await db.getAppliedPolicySnapshot('DOGE', 'FUFU');
        assert.strictEqual(applied, null);
        assert.strictEqual(mirror.doQuery.callCount, 0);
    });
});

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
 * Health advertises COMMITTED height only.
 *
 * health() used to read lastIndexedBlock off the RAW db handle. doQuery ->
 * getConnection() returns the block loop's open transactionConnection while a
 * block is processing, so that read landed INSIDE the uncommitted block. Every
 * federation query guard instead reads through apiView() (the committed-only
 * independent pooled connection, / H2) and answers `block_index N not
 * yet indexed (latest: N-1)`. The two endpoints therefore disagreed by exactly
 * one block, and any client that polls health and then queries AT the height
 * health just reported failed deterministically whenever the poll landed
 * mid-block (measured: 13423/13422, 13442/13441, 13451/13450 on a healthy,
 * lag-0 indexer). It is also a correctness bug outside tests: an in-flight
 * block that later rolls back means health advertised a height that never
 * committed.
 *
 * Part 1 exercises the real Database class (pool + transaction stubbed) to pin
 * the divergence and the fix. Part 2 is a static guard over src/api.js so the
 * height-advertising endpoints cannot regress to a bare read.
 *********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const Database = require('../../src/db.js');
const { buildHealthResponse, committedView, inFlightBlockIndex } = require('../../src/health');

const COMMITTED   = 13422;   // the height a committed-only reader can answer at
const UNCOMMITTED = 13423;   // the block inside the block loop's open transaction

// Minimal indexer stand-in: the Database constructor only needs config + util,
// and createPool() does not dial out until a connection is drawn (we replace
// the pool below, so it never is).
function makeDb(){
    const db = new Database('127.0.0.1', 3306, 'x', 'u', 'p', {
        config: {},
        util: {
            isNull:     (v) => v === null || v === undefined,
            logError:   () => {},
            throwError: (m) => { throw new Error(m); }
        }
    });
    // The independent pool: committed state only.
    db.pool = {
        getConnection: async () => ({
            query:   async () => [{ max_block: COMMITTED }],
            release: async () => {}
        })
    };
    return db;
}

// Put the db mid-block: an open ACID transaction whose connection sees the
// block's own uncommitted rows, exactly as the block loop leaves it between
// beginTransaction() and commitTransaction().
function openBlock(db, blockIndex = UNCOMMITTED){
    db.transactionConnection = {
        query:   async () => [{ max_block: blockIndex }],
        release: async () => {}
    };
    db.blockIndex = blockIndex;      // stamped by XChainIndexer right after beginTransaction
    return db;
}

describe('health advertises committed height only @regression @tier1', function(){

    describe('committedView()', function(){

        it('reads the COMMITTED height while a block transaction is open', async function(){
            const db = openBlock(makeDb());
            // The raw handle dirty-reads the open block: this is the defect being fixed.
            assert.strictEqual(await db.getLatestBlockIndex(), UNCOMMITTED,
                'sanity: the raw handle still dirty-reads the open block transaction');
            assert.strictEqual(await committedView(db).getLatestBlockIndex(), COMMITTED,
                'health must read the committed height, not the block it is parsing');
        });

        it('never exceeds what a federation query guard accepts', async function(){
            const db = openBlock(makeDb());
            // getcapabilityvalidators & friends resolve their db via apiView() and
            // reject anything above the height it can see. Same view, so by
            // construction health can never advertise a height they refuse.
            const advertised = await committedView(db).getLatestBlockIndex();
            const guardSees  = await db.apiView().getLatestBlockIndex();
            assert.ok(advertised <= guardSees,
                'health advertised ' + advertised + ' but the guard only accepts up to ' + guardSees);
        });

        it('is the same committed height once the block commits', async function(){
            const db = makeDb();                       // no open transaction
            assert.strictEqual(await committedView(db).getLatestBlockIndex(), COMMITTED);
            assert.strictEqual(await db.getLatestBlockIndex(), COMMITTED,
                'outside a transaction both paths agree');
        });

        it('falls back to the raw handle for a stub without apiView', async function(){
            const stub = { async getLatestBlockIndex(){ return 7; } };
            assert.strictEqual(await committedView(stub).getLatestBlockIndex(), 7);
            assert.strictEqual(committedView(null), null);
        });
    });

    describe('inFlightBlockIndex()', function(){

        it('reports the block inside the open transaction', function(){
            assert.strictEqual(inFlightBlockIndex(openBlock(makeDb())), UNCOMMITTED);
        });

        it('is null when no block transaction is open, even with a stale blockIndex', function(){
            // db.blockIndex is NOT cleared on commit, so the transactionConnection
            // gate is what makes the field mean "in flight" rather than "last seen".
            const db = makeDb();
            db.blockIndex = UNCOMMITTED;
            db.transactionConnection = null;
            assert.strictEqual(inFlightBlockIndex(db), null);
        });

        it('is null for a stub db and for no db at all', function(){
            assert.strictEqual(inFlightBlockIndex({ async getLatestBlockIndex(){ return 1; } }), null);
            assert.strictEqual(inFlightBlockIndex(null), null);
            assert.strictEqual(inFlightBlockIndex(undefined), null);
        });
    });

    describe('response shape', function(){

        function indexerStub(){
            return {
                decoderDb:        { circuitState: 'closed' },
                indexerDb:        { circuitState: 'closed' },
                lastDecoderBlock: UNCOMMITTED,
                isSynced:         () => true
            };
        }

        it('reports committed and in-flight heights as separate fields', async function(){
            const res = await buildHealthResponse({
                indexer: indexerStub(), indexerRunning: true, indexerError: null,
                lastIndexedBlock: COMMITTED, inFlightBlock: UNCOMMITTED, now: 1_000_000, reorgStats: null
            });
            assert.strictEqual(res.lastIndexedBlock, COMMITTED,
                'lastIndexedBlock is the committed height a caller may query at');
            assert.strictEqual(res.inFlightBlock, UNCOMMITTED,
                'the block being parsed is reported separately, never folded into lastIndexedBlock');
            // lag stays measured against the committed height so a mid-block poll
            // reads as lag 1, not a fictitious lag 0.
            assert.strictEqual(res.lag, 1);
        });

        it('inFlightBlock is null when the caller passes none (no block open)', async function(){
            const res = await buildHealthResponse({
                indexer: indexerStub(), indexerRunning: true, indexerError: null,
                lastIndexedBlock: COMMITTED, now: 1_000_000, reorgStats: null
            });
            assert.strictEqual(res.inFlightBlock, null);
        });
    });

    describe('src/api.js height-advertising endpoints (static guard)', function(){
        // startApi() is not importable (it opens DB connections and auto-starts),
        // so guard the source the same way api-federation-read-isolation.test.js does.
        const API_SRC = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');

        // Slice the health() and getlatestblock() handler bodies out of the
        // jsonRpcController object literal.
        function handlerBody(name){
            const decl = new RegExp('\\n {8}async\\s+' + name + '\\s*\\(');
            const m = decl.exec(API_SRC);
            assert.ok(m, 'handler not found in src/api.js: ' + name);
            const rest = API_SRC.slice(m.index + 1);
            const next = /\n {8}async\s+\w+\s*\(/.exec(rest);
            return next ? rest.slice(0, next.index) : rest;
        }

        // The whole app.get('/status', ...) route.
        function statusRoute(){
            const start = API_SRC.indexOf("app.get('/status'");
            assert.ok(start > 0, "app.get('/status') not found in src/api.js");
            const end = API_SRC.indexOf('\n    });', start);
            assert.ok(end > start, "could not find the end of the '/status' route");
            return API_SRC.slice(start, end);
        }

        // A handler may either call committedView() inline or bind it once
        // (`let db = committedView(indexer.indexerDb)`) and read off the binding.
        // Return the binding name so the guard can follow it, or null for inline.
        function committedBinding(body, handle){
            const re = new RegExp('(\\w+)\\s*=\\s*committedView\\(\\s*indexer\\.' + handle + '\\s*\\)');
            const m  = re.exec(body);
            return m ? m[1] : null;
        }

        // Every height read must resolve through committedView(indexer.indexerDb),
        // inline or via a binding.
        function assertsCommittedHeight(name, body){
            if(/committedView\(\s*indexer\.indexerDb\s*\)\.getLatestBlockIndex\(\)/.test(body)) return;
            const bound = committedBinding(body, 'indexerDb');
            assert.ok(bound, name + ' must read the height via committedView(indexer.indexerDb), not the raw handle');
            assert.match(body, new RegExp('\\b' + bound + '\\.getLatestBlockIndex\\(\\)'),
                name + ' binds committedView() as `' + bound + '` but does not read the height off it');
        }

        const TARGETS = {
            // Endpoints that ADVERTISE a height: they must also surface the
            // in-flight block separately rather than folding it into the height.
            'health()':         { body: handlerBody('health'),        advertisesInFlight: true },
            'getlatestblock()': { body: handlerBody('getlatestblock'), advertisesInFlight: true },
            '/status':          { body: statusRoute(),                advertisesInFlight: true },
            // getblockhashes does not advertise a height, it MINTS the
            // hashes the hub's StateCheckpointEngine quorum-signs into the
            // XCHECKPOINT canonical. Same dirty-read class as, worse blast
            // radius: a mid-block read gets a state hash for a block a reorg may
            // still erase, and the signature outlives the rollback. Its default
            // target height AND the stored-hash row must both come off the
            // committed view, and so must the decoder-side chain block hash that
            // is signed alongside them.
            'getblockhashes()': { body: handlerBody('getblockhashes'), advertisesInFlight: false,
                                  guardsDecoderDb: true }
        };

        for(const [name, target] of Object.entries(TARGETS)){
            const body = target.body;

            it(name + ' reads its height through committedView()', function(){
                assertsCommittedHeight(name, body);
            });

            it(name + ' makes no bare indexer.indexerDb read (would join the open block tx)', function(){
                // The only permitted `.` after the handle is `.apiView()`; the
                // readiness guard `if(!indexer.indexerDb)` has no trailing dot.
                const bare = /indexer\.indexerDb\.(?!apiView\b)/.exec(body);
                assert.ok(!bare, name + ' calls a bare indexer.indexerDb.' +
                    (bare ? bare.input.slice(bare.index + 'indexer.indexerDb.'.length, bare.index + 40) : '') +
                    ' - route it through committedView()/apiView()');
            });

            if(target.advertisesInFlight){
                it(name + ' reports the in-flight block separately', function(){
                    assert.match(body, /inFlightBlockIndex\(\s*indexer\.indexerDb\s*\)/,
                        name + ' must surface the in-flight block explicitly rather than folding it into the height');
                });
            }

            if(target.guardsDecoderDb){
                it(name + ' makes no bare indexer.decoderDb read either', function(){
                    const bare = /indexer\.decoderDb\.(?!apiView\b)/.exec(body);
                    assert.ok(!bare, name + ' calls a bare indexer.decoderDb.' +
                        (bare ? bare.input.slice(bare.index + 'indexer.decoderDb.'.length, bare.index + 40) : '') +
                        ' - route it through committedView()/apiView()');
                    assert.ok(committedBinding(body, 'decoderDb')
                              || /committedView\(\s*indexer\.decoderDb\s*\)\./.test(body),
                        name + ' must read the chain block hash through committedView(indexer.decoderDb)');
                });

                it(name + ' reads the stored hash row off the committed view', function(){
                    // The row itself, not just the default height: reading the
                    // triple mid-block is what hands the checkpoint engine a hash
                    // for an uncommitted block.
                    const bound = committedBinding(body, 'indexerDb');
                    const re = bound
                        ? new RegExp('\\b' + bound + '\\.getStoredBlockHashes\\(')
                        : /committedView\(\s*indexer\.indexerDb\s*\)\.getStoredBlockHashes\(/;
                    assert.match(body, re,
                        name + ' must read getStoredBlockHashes() off the committed view');
                });
            }
        }
    });

    // Runtime proof for the signing path: the hash row a mid-block read
    // returns is not the row a committed-only reader sees, and it is the committed
    // one the checkpoint engine must sign.
    describe('getStoredBlockHashes() through committedView()', function(){

        const COMMITTED_LEDGER   = 'aa'.repeat(32);
        const UNCOMMITTED_LEDGER = 'bb'.repeat(32);

        // Same Database class as above, but the two connections answer the stored
        // block-hash query with DIFFERENT rows, which is exactly the mid-block
        // situation: the open transaction can see the block's own hash row before
        // any other reader (or any reorg) can.
        function makeHashDb(){
            const db = makeDb();
            db.pool = {
                getConnection: async () => ({
                    query: async (sql) => sql.includes('MAX(block_index)')
                        ? [{ max_block: COMMITTED }]
                        : [{ block_index: COMMITTED, block_time: 1, ledger_hash: COMMITTED_LEDGER }],
                    release: async () => {}
                })
            };
            db.transactionConnection = {
                query: async (sql) => sql.includes('MAX(block_index)')
                    ? [{ max_block: UNCOMMITTED }]
                    : [{ block_index: UNCOMMITTED, block_time: 2, ledger_hash: UNCOMMITTED_LEDGER }],
                release: async () => {}
            };
            db.blockIndex = UNCOMMITTED;
            return db;
        }

        it('returns the committed hash row while a block transaction is open', async function(){
            const db = makeHashDb();
            const dirty = await db.getStoredBlockHashes(UNCOMMITTED);
            assert.strictEqual(dirty.ledger_hash, UNCOMMITTED_LEDGER,
                'sanity: the raw handle still dirty-reads the open block transaction');
            const clean = await committedView(db).getStoredBlockHashes(COMMITTED);
            assert.strictEqual(clean.ledger_hash, COMMITTED_LEDGER,
                'the checkpoint engine must be handed the committed hash, never the in-flight one');
        });

        it('defaults its target height to the committed tip, not the in-flight block', async function(){
            const db = makeHashDb();
            assert.strictEqual(await committedView(db).getLatestBlockIndex(), COMMITTED,
                'an omitted block_index must resolve to a block that has actually committed');
        });
    });
});

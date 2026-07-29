#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * Arming-block cost for contract_state_root (SPV sub-tree spec §3 Stage A item 6,
 *  stage A3).
 *
 * WHAT IS BEING MEASURED AND WHY IT MATTERS. The first block at an armed height
 * runs buildFullContractStateRoot over the WHOLE live contract-state set, on the
 * indexer and on every follower at once, inside the block transaction. Per-contract
 * keys are capped by the VM's maxStateKeys; the CONTRACT COUNT is not, so the total
 * is unbounded by anything the protocol enforces. If that build takes longer than
 * the chain's block interval the fleet falls behind at exactly the moment everyone
 * is watching, so the figure has to exist before a mainnet height is chosen.
 *
 * THREE MODES, because they measure different halves and only one is portable:
 *
 *   --synthetic N     Hash-and-tree cost for N keys through the REAL derivation
 *                     with an in-memory node store. Portable, deterministic, no DB.
 *                     This is a FLOOR: it excludes storage I/O entirely.
 *
 *   --synthetic N --persist --scratch <table>
 *                     The same N synthetic keys through the REAL DbNodeStore against
 *                     a REAL MariaDB, inside a REAL transaction, in a throwaway table
 *                     this tool creates and drops. This is the storage term.
 *
 *   --db <name>       The real thing against a live indexer database: the actual
 *                     row set, the actual MariaDB node store, the actual queries.
 *                     Reads only; writes go to a throwaway in-memory store unless
 *                     --persist is passed.
 *
 * READ THE FLOOR AS A FLOOR. Each key is a 256-level SMT descent, and every level
 * that is not an empty subtree is a SEQUENTIAL round trip to state_tree_nodes. On a
 * populated tree the DB term dominates the hashing term by orders of magnitude, so
 * a synthetic number that looks comfortable proves nothing about a real arming
 * block.
 *
 * WHY THE SCRATCH MODE EXISTS, since the spec originally deferred this figure to a
 * venue that does not exist. The storage term is a function of the KEY COUNT alone:
 * every key is the same 256-level copy-on-write descent whatever value hangs off it.
 * So "how much does a real node store cost per key" does NOT need a venue carrying
 * real contract state, only a database. Waiting for real contract state to measure it
 * left the decisive number (round trips, not hashes) unquoted while a portable
 * measurement was available the whole time.
 *
 * AND THE SHAPE QUESTION IS ANSWERED RATHER THAN DEFERRED, which is what --shape is
 * for. The worry was that a production key set's shape (many contracts vs few, keys
 * sharing long prefixes) might change the cost. It cannot, and now that is measured
 * instead of argued: copy-on-write writes a NEW node at all 256 levels of every
 * update, so the row count is exactly 256 per key no matter how the keys cluster, and
 * the key digest is a hash so contract clustering does not cluster the descent either.
 * Measured 2026-07-29 at 500 keys, all four shapes: 128,000 node rows each, to the
 * row, and 46-50 ms/key, a spread of 7% which is run-to-run noise. Quote the key
 * COUNT when choosing an arming height and ignore the shape.
 *
 * USAGE
 *   node bin/bench-contract-state-root.js --synthetic 1000
 *   node bin/bench-contract-state-root.js --synthetic 1000,10000,50000
 *   node bin/bench-contract-state-root.js --synthetic 100,1000 --persist --scratch bench_state_tree_nodes
 *   node bin/bench-contract-state-root.js --synthetic 500 --shape spread,deep,wide,prefix
 *   node bin/bench-contract-state-root.js --db XChain_BTC_Regtest_Indexer --chain BTC --network regtest
 *
 * DB and scratch modes read credentials the same way the indexer does (its own
 * config layer), and never take them on the command line.
 *
 *********************************************************************/

'use strict';

const CST = require('../src/contractStateSubtree.js');
const SC  = require('../src/stateCommitment.js');

function parseArgs(argv){
    const out = { synthetic: null, db: null, chain: 'BTC', network: 'regtest', persist: false,
                  scratch: null, keep: false, shapes: ['spread'] };
    for(let i = 2; i < argv.length; i++){
        switch(argv[i]){
            case '--synthetic': out.synthetic = String(argv[++i] || '').split(',').map(s => parseInt(s, 10)); break;
            case '--db':
                out.db = argv[++i];
                // Without this, a bare --db falls through to the synthetic default and
                // silently reports a floor figure to someone who asked for the real one.
                if(!out.db){ console.error('--db needs a database name'); process.exit(64); }
                break;
            case '--chain':     out.chain   = String(argv[++i] || '').toUpperCase(); break;
            case '--network':   out.network = argv[++i]; break;
            case '--persist':   out.persist = true; break;
            case '--scratch':
                out.scratch = argv[++i];
                if(!out.scratch){ console.error('--scratch needs a database name'); process.exit(64); }
                break;
            case '--shape':
                out.shapes = String(argv[++i] || '').split(',').filter(Boolean);
                for(const s of out.shapes)
                    if(!SHAPES.includes(s)){
                        console.error('unknown --shape "' + s + '" (want ' + SHAPES.join(', ') + ')');
                        process.exit(64);
                    }
                break;
            case '--keep':      out.keep = true; break;
            case '-h': case '--help':
                console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
                process.exit(0);
                break;
            default:
                console.error('unknown arg: ' + argv[i]);
                process.exit(64);
        }
    }
    if(!out.synthetic && !out.db){ out.synthetic = [1000, 10000]; }
    return out;
}

// A db stub serving N synthetic live keys through the REAL full-build query shape.
//
// SHAPES, because "what does a production key set look like" was the last open leg of
// the arming-cost question and it is answerable rather than something to wait for a
// venue to reveal. The four below bracket the space: keys spread thinly over many
// contracts, all keys under one contract, one key per contract, and the adversarial
// case where every state_key shares a long common prefix. If the cost were sensitive
// to any of that, these would disagree.
//
//   spread  n/25 contracts x 25 keys      (the default, closest to real state)
//   deep    1 contract x n keys
//   wide    n contracts x 1 key
//   prefix  1 contract, keys sharing a 48-char common prefix
const SHAPES = ['spread', 'deep', 'wide', 'prefix'];

function syntheticDb(n, shape){
    const rows = [];
    for(let i = 0; i < n; i++){
        let contract, key;
        switch(shape){
            case 'deep':   contract = 1;     key = 'key_' + i; break;
            case 'wide':   contract = 1 + i; key = 'key_0';    break;
            case 'prefix': contract = 1;     key = 'k'.repeat(48) + '_' + i; break;
            default:       contract = 1 + (i % Math.max(1, Math.floor(n / 25)));
                           key = 'key_' + i;
        }
        rows.push({ contract_index: contract, state_key: key,
                    state_value: JSON.stringify({ i: i, pad: 'x'.repeat(32) }) });
    }
    // Both readers: the derivation reads strictly (M-17), and a stub carrying
    // only doQuery would make buildFullContractStateRoot throw here rather than
    // benchmark anything.
    return { async doQuery(){ return rows; }, async doQueryStrict(){ return rows; } };
}

// Wrap a node store to count the two operations that ARE the storage term. The
// counts are a property of the derivation, not of the backend, so counting them in
// both modes is what turns "the DB one is slower" into a per-round-trip figure.
function countingStore(inner){
    const stat = { gets: 0, puts: 0, getMs: 0, putMs: 0 };
    return {
        stat: stat,
        async get(h){
            stat.gets++;
            const t = process.hrtime.bigint();
            try { return await inner.get(h); }
            finally { stat.getMs += Number(process.hrtime.bigint() - t) / 1e6; }
        },
        async put(h, l, r){
            stat.puts++;
            const t = process.hrtime.bigint();
            try { return await inner.put(h, l, r); }
            finally { stat.putMs += Number(process.hrtime.bigint() - t) / 1e6; }
        }
    };
}

async function runSynthetic(sizes, shapes){
    console.log('# synthetic full build (in-memory node store; a FLOOR, no storage I/O)');
    console.log('# shape     keys        ms       ms/key    nodes      get+put ops');
    for(const shape of shapes)
    for(const n of sizes){
        if(!Number.isInteger(n) || n <= 0){ console.error('bad size: ' + n); continue; }
        const inner = new SC.MemoryNodeStore();
        const store = countingStore(inner);
        const smt   = new SC.PersistentSMT(store);
        const db    = syntheticDb(n, shape);
        const t0    = process.hrtime.bigint();
        const root  = await CST.buildFullContractStateRoot(db, smt, 'BTC', 'regtest');
        const ms    = Number(process.hrtime.bigint() - t0) / 1e6;
        console.log('  ' + shape.padEnd(10) + String(n).padEnd(10) + ms.toFixed(0).padEnd(9) +
                    (ms / n).toFixed(4).padEnd(10) + String(inner.size).padEnd(11) +
                    (store.stat.gets + store.stat.puts));
        if(!root || root.length !== 64) throw new Error('benchmark produced no root');
    }
    console.log('\n# The per-key figure is roughly flat: each key is an independent 256-level');
    console.log('# descent. Extrapolate linearly in the key count, then ADD the storage term,');
    console.log('# which --persist mode measures (scratch DB) or --db mode measures in situ.');
}

// The scratch is a TABLE inside the indexer's own database, not a database of its
// own: an indexer's DB user is scoped to its schema and has no CREATE DATABASE
// grant, and benchmarking is not a reason to hand one out. One guard, and it is the
// one that matters: the name must SAY it is a bench table, so the live
// `state_tree_nodes` can never be named here by accident.
function assertScratchNameSafe(name){
    if(!/bench/i.test(name) || !/^[A-Za-z0-9_]+$/.test(name)){
        console.error('--scratch refuses "' + name + '": it must be a plain identifier containing ' +
                      '"bench", so the live state_tree_nodes can never be named here by accident.');
        process.exit(64);
    }
}

// Point the REAL DbNodeStore at the scratch table by rewriting the one identifier in
// its statements, rather than retyping them here. The store's SQL stays the SQL the
// arming block runs; only the table it lands in changes, in one visible place.
function tableRedirect(db, table){
    const swap = sql => String(sql).replace(/state_tree_nodes/g, table);
    return {
        async doQueryStrict(sql, args){ return db.doQueryStrict(swap(sql), args); },
        async doQuery(sql, args){ return db.doQuery(swap(sql), args); }
    };
}

async function openIndexerDb(opts){
    const Database = require('../src/db.js');
    const config   = require('../src/config.js');
    const Utility  = require('../src/utility.js');
    const host = process.env.INDEXER_DB_HOST;
    const port = process.env.INDEXER_DB_PORT;
    const user = process.env.INDEXER_DB_USER;
    const pass = process.env.INDEXER_DB_PASS;
    const name = opts.db || process.env.INDEXER_DB_NAME;
    if(!host || !user || !name){
        console.error('bench: INDEXER_DB_HOST / INDEXER_DB_USER / INDEXER_DB_NAME must be set ' +
                      '(load the service .env).');
        process.exit(2);
    }
    const cfg = config.getConfig(opts.chain, opts.network);
    return new Database(host, port, name, user, pass, { config: cfg, util: new Utility(cfg) });
}

async function runSyntheticPersisted(opts){
    assertScratchNameSafe(opts.scratch);
    const db = await openIndexerDb(opts);
    // The table definition is the indexer's own, read rather than retyped, so the
    // benchmark cannot drift from the schema the arming block actually writes.
    const ddl = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'sql',
                                                                'state_tree_nodes.sql'), 'utf8')
        .replace(/^\s*--.*$/gm, '')
        .replace('CREATE TABLE state_tree_nodes', 'CREATE TABLE IF NOT EXISTS ' + opts.scratch)
        .trim().replace(/;$/, '');
    await db.doQueryStrict(ddl, []);
    const proxy = tableRedirect(db, opts.scratch);
    console.log('# synthetic full build, REAL DbNodeStore, REAL transaction, scratch table ' + opts.scratch);
    console.log('# shape     keys      build ms   ms/key    commit ms  node rows   gets     puts     ms/op');
    try {
        for(const shape of opts.shapes)
        for(const n of opts.synthetic){
            if(!Number.isInteger(n) || n <= 0){ console.error('bad size: ' + n); continue; }
            await db.doQueryStrict('TRUNCATE TABLE ' + opts.scratch, []);

            const store = countingStore(new SC.DbNodeStore(proxy));
            const smt   = new SC.PersistentSMT(store);
            const rows  = syntheticDb(n, shape);

            // Inside a transaction, because that is where the arming block runs it and
            // because the transaction SIZE is half of what makes this expensive.
            await db.beginTransaction();
            const t0   = process.hrtime.bigint();
            let root;
            try {
                root = await CST.buildFullContractStateRoot(rows, smt, opts.chain, opts.network);
            } catch(e){
                await db.rollbackTransaction();
                throw e;
            }
            const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
            const t1 = process.hrtime.bigint();
            await db.commitTransaction();
            const commitMs = Number(process.hrtime.bigint() - t1) / 1e6;

            const cnt = await db.doQueryStrict('SELECT COUNT(*) AS c FROM ' + opts.scratch, []);
            const ops = store.stat.gets + store.stat.puts;
            console.log('  ' + shape.padEnd(10) + String(n).padEnd(10) +
                        buildMs.toFixed(0).padEnd(11) +
                        (buildMs / n).toFixed(2).padEnd(10) +
                        commitMs.toFixed(0).padEnd(11) +
                        String(cnt[0].c).padEnd(12) +
                        String(store.stat.gets).padEnd(9) +
                        String(store.stat.puts).padEnd(9) +
                        (ops ? (store.stat.getMs + store.stat.putMs) / ops : 0).toFixed(3));
            if(!root || root.length !== 64) throw new Error('benchmark produced no root');
        }
    } finally {
        if(!opts.keep){
            // A failed DROP must not swallow the figures the run just produced, so
            // report the leftover table by name instead of throwing over it.
            try {
                await db.doQueryStrict('DROP TABLE IF EXISTS ' + opts.scratch, []);
                console.log('\n# scratch table ' + opts.scratch + ' dropped (--keep to retain it)');
            } catch(e){
                console.log('\n# could not drop ' + opts.scratch + ' (' + (e && (e.code || e.message)) +
                            '); drop it by hand.');
            }
        }
        if(db.close) await db.close();
    }
    console.log('# ms/op is the number to extrapolate with: the build is SEQUENTIAL round trips,');
    console.log('# so a key set of K costs about (ops/key) * K * ms/op regardless of hardware speed');
    console.log('# in the hashing term. Compare against the target chain\'s block interval.');
}

async function runDb(opts){
    // Credentials come from the service environment exactly as src/migrate.js reads
    // them: never from the command line, never printed. --db only picks the DATABASE
    // NAME (so one host can benchmark any of its chains); everything else is the
    // running indexer's own configuration.
    const Database = require('../src/db.js');
    const config   = require('../src/config.js');
    const Utility  = require('../src/utility.js');
    const host = process.env.INDEXER_DB_HOST;
    const port = process.env.INDEXER_DB_PORT;
    const user = process.env.INDEXER_DB_USER;
    const pass = process.env.INDEXER_DB_PASS;
    const name = opts.db || process.env.INDEXER_DB_NAME;
    if(!host || !name || !user){
        console.error('bench: INDEXER_DB_HOST / INDEXER_DB_USER must be set and a database named ' +
                      '(load the service .env, then pass --db <name>).');
        process.exit(2);
    }
    // The Database constructor needs only { config, util } off its parent, and the
    // two must SHARE one config object (see the Utility constructor).
    const cfg = config.getConfig(opts.chain, opts.network);
    const db  = new Database(host, port, name, user, pass, { config: cfg, util: new Utility(cfg) });
    const counts = await db.doQuery(
        'SELECT COUNT(*) AS rows_total, COUNT(DISTINCT contract_index) AS contracts FROM contract_state', []);
    const live = await db.doQuery(
        'SELECT COUNT(*) AS live_keys FROM (SELECT MAX(id) AS id FROM contract_state ' +
        'GROUP BY contract_index, state_key_bin) t', []);
    console.log('# ' + opts.db + ': ' + counts[0].rows_total + ' rows, ' +
                counts[0].contracts + ' contracts, ' + live[0].live_keys + ' live keys');

    const store = opts.persist ? new SC.DbNodeStore(db) : new SC.MemoryNodeStore();
    const smt   = new SC.PersistentSMT(store);
    const t0    = process.hrtime.bigint();
    const root  = await CST.buildFullContractStateRoot(db, smt, opts.chain, opts.network);
    const ms    = Number(process.hrtime.bigint() - t0) / 1e6;
    const keys  = Number(live[0].live_keys) || 1;
    console.log('# full build: ' + ms.toFixed(0) + ' ms  (' + (ms / keys).toFixed(3) + ' ms/live key)');
    console.log('# root: ' + root);
    console.log('# node store: ' + (opts.persist ? 'PERSISTED to state_tree_nodes' : 'in-memory (read-only run)'));
    if(db.close) await db.close();
}

(async () => {
    const opts = parseArgs(process.argv);
    if(opts.db)                              await runDb(opts);
    else if(opts.persist && opts.scratch)    await runSyntheticPersisted(opts);
    else if(opts.persist){
        console.error('--persist needs either --db <live db> or --scratch <bench table>. Refusing to ' +
                      'quote an in-memory figure to someone who asked for the persisted one.');
        process.exit(64);
    }
    else                                     await runSynthetic(opts.synthetic, opts.shapes);
    // Explicit, because a Database whose build predates close() leaves pool sockets on
    // the event loop and the tool hangs after printing its results. That looks exactly
    // like a benchmark still running, which is the one illusion a benchmark must not
    // create: the first scratch run was read as 10 minutes when it took 12 seconds.
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

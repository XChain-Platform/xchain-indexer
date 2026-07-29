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
 * TWO MODES, because they measure different halves and only one is portable:
 *
 *   --synthetic N     Hash-and-tree cost for N keys through the REAL derivation
 *                     with an in-memory node store. Portable, deterministic, no DB.
 *                     This is a FLOOR: it excludes storage I/O entirely.
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
 * block. Quote the --db figure when setting a height; quote the synthetic one only
 * to reason about scaling shape.
 *
 * USAGE
 *   node bin/bench-contract-state-root.js --synthetic 1000
 *   node bin/bench-contract-state-root.js --synthetic 1000,10000,50000
 *   node bin/bench-contract-state-root.js --db XChain_BTC_Regtest_Indexer --chain BTC --network regtest
 *
 * DB mode reads credentials the same way the indexer does (its own config layer),
 * and never takes them on the command line.
 *
 *********************************************************************/

'use strict';

const CST = require('../src/contractStateSubtree.js');
const SC  = require('../src/stateCommitment.js');

function parseArgs(argv){
    const out = { synthetic: null, db: null, chain: 'BTC', network: 'regtest', persist: false };
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
// Keys are spread across contracts the way real state is (many contracts, bounded
// keys each) rather than all under one, because the SMT path depends on the KEY
// digest and clustering changes nothing, but the row set shape should still look
// like production for anyone reading this later.
function syntheticDb(n){
    const rows = [];
    for(let i = 0; i < n; i++)
        rows.push({ contract_index: 1 + (i % Math.max(1, Math.floor(n / 25))),
                    state_key: 'key_' + i,
                    state_value: JSON.stringify({ i: i, pad: 'x'.repeat(32) }) });
    return { async doQuery(){ return rows; } };
}

async function runSynthetic(sizes){
    console.log('# synthetic full build (in-memory node store; a FLOOR, no storage I/O)');
    console.log('# keys        ms       ms/key    nodes');
    for(const n of sizes){
        if(!Number.isInteger(n) || n <= 0){ console.error('bad size: ' + n); continue; }
        const store = new SC.MemoryNodeStore();
        const smt   = new SC.PersistentSMT(store);
        const db    = syntheticDb(n);
        const t0    = process.hrtime.bigint();
        const root  = await CST.buildFullContractStateRoot(db, smt, 'BTC', 'regtest');
        const ms    = Number(process.hrtime.bigint() - t0) / 1e6;
        console.log('  ' + String(n).padEnd(10) + ms.toFixed(0).padEnd(9) +
                    (ms / n).toFixed(4).padEnd(10) + store.size);
        if(!root || root.length !== 64) throw new Error('benchmark produced no root');
    }
    console.log('\n# The per-key figure is roughly flat: each key is an independent 256-level');
    console.log('# descent. Extrapolate linearly in the key count, then ADD the storage term,');
    console.log('# which --db mode is the only way to measure.');
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
    if(opts.db) await runDb(opts);
    else        await runSynthetic(opts.synthetic);
})().catch(e => { console.error(e); process.exit(1); });

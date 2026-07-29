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
 * Arming-block cost AND real-venue attribution conformance for the XCHAIN_ESC
 * locked-balance leaf (SPV sub-tree spec §3 Stage B / §7 step 4,  stage B3).
 *
 * WHAT THE ARMING BLOCK ACTUALLY DOES, which is why this exists. At the first
 * armed height the source runs writeEscrowJournal(full:true): a from-genesis
 * REPLAY of the entire `escrows` ledger, attributing every row to its locker,
 * inside the block transaction. Both twins then full-build balances_root with
 * the resulting locked leaves. So the arming block carries TWO unbounded terms,
 * and they scale on different things:
 *
 *   replay      O(escrow ROWS ever written)  <- this harness
 *   full build  O(live locked KEYS)          <- the same ~0.5 ms/key SMT cost
 *                                               bench-contract-state-root.js
 *                                               already characterised; the tree
 *                                               code is shared, so it is not
 *                                               re-measured here.
 *
 * The row count is the one nobody thinks about: a chain with a busy DEX has far
 * more escrow ROWS (every lock and every release, forever) than it has live
 * locked keys, and the replay reads all of them.
 *
 * TWO MODES, and unlike Stage A the real one is available TODAY, because regtest
 * carries genuine escrow rows where every fleet contract_state table was empty:
 *
 *   --synthetic N   Attribution + accumulation for N synthetic rows through the
 *                   REAL writer against a stub db. Portable, no DB. A FLOOR: it
 *                   excludes every per-row resolver round trip, which is the
 *                   term that dominates on a real ledger.
 *
 *   --db <name>     The real thing, READ-ONLY (opts.dryRun: attribute, sum,
 *                   cross-check, never INSERT). This is simultaneously the cost
 *                   measurement and the ATTRIBUTION CONFORMANCE PASS: every
 *                   fail-loud check fires (unclassified action type, unresolvable
 *                   refs, negative key total, and the per-tick cross-check against
 *                   SQL SUM(escrows)), so a clean run is evidence that the frozen
 *                   attribution rules hold against data no stub can model.
 *                   RUN THIS BEFORE ARMING ANY CHAIN.
 *
 * USAGE
 *   node bin/bench-escrow-arming-replay.js --synthetic 1000
 *   node bin/bench-escrow-arming-replay.js --synthetic 1000,10000,50000
 *   node bin/bench-escrow-arming-replay.js --db XChain_BTC_Regtest_Indexer --chain BTC --network regtest
 *
 * DB mode reads credentials the same way the indexer does (its own config layer),
 * and never takes them on the command line. It writes nothing, ever.
 *
 *********************************************************************/

'use strict';

const EJW = require('../src/escrowJournalWriter.js');

function parseArgs(argv){
    const out = { synthetic: null, db: null, chain: 'BTC', network: 'regtest' };
    for(let i = 2; i < argv.length; i++){
        switch(argv[i]){
            case '--synthetic': out.synthetic = String(argv[++i] || '').split(',').map(s => parseInt(s, 10)); break;
            case '--db':
                out.db = argv[++i];
                // A bare --db must not fall through to the synthetic default and
                // report a floor to someone who asked for the real figure.
                if(!out.db){ console.error('--db needs a database name'); process.exit(64); }
                break;
            case '--chain':   out.chain   = String(argv[++i] || '').toUpperCase(); break;
            case '--network': out.network = argv[++i]; break;
            case '-h': case '--help':
                console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
                process.exit(0);
                break;
            default:
                console.error('unknown arg: ' + argv[i]);
                process.exit(64);
        }
    }
    if(!out.synthetic && !out.db) out.synthetic = [1000, 10000];
    return out;
}

// Minimal bignumber shim matching utility.js's bc* contract (the writer only
// uses bcnum/bcstr/bcadd/bclt). Kept local so the harness does not need a live
// Utility, and byte-compatible because both route through mathjs bignumbers.
const mathjs = require('mathjs');
const UTIL = {
    bcnum(n){ const s = String(n).trim(); return /^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(s) ? mathjs.bignumber(s) : mathjs.bignumber(0); },
    bcstr(n){ return this.bcnum(n).toFixed(); },
    bcadd(a, b, d){ return this.bcnum(mathjs.format(mathjs.add(this.bcnum(a), this.bcnum(b)), { notation: 'fixed', precision: parseInt(d) })); },
    bclt(a, b){ return this.bcnum(a).lt(this.bcnum(b)); }
};

// N synthetic escrow rows shaped like a real ledger: locks keyed to their own
// locker (self-attributing) interleaved with ORDER_MATCH releases keyed to a
// recipient, so the resolver path is exercised rather than skipped.
function syntheticDb(n){
    const rows = [], matches = {}, sources = {};
    const lockers = Math.max(1, Math.floor(n / 4));
    for(let i = 0; i < n; i++){
        const locker = '1Locker' + (i % lockers);
        if(i % 3 === 2){
            // Release keyed to a recipient: resolves through order_matches.
            const ai = 1000000 + i;
            matches[ai] = { give_action_index: 2000000 + i, get_action_index: 3000000 + i,
                            give_tick_id: 1, get_tick_id: 2 };
            sources[3000000 + i] = locker;
            sources[2000000 + i] = '1Other' + (i % lockers);
            rows.push({ action_index: ai, action_name: 'ORDER_MATCH', address: '1Recipient' + i,
                        tick: 'ALPHA', tick_id: 1, amount: '-1' });
        } else {
            rows.push({ action_index: 500000 + i, action_name: 'ORDER', address: locker,
                        tick: 'ALPHA', tick_id: 1, amount: '2' });
        }
    }
    return {
        util: UTIL,
        async doQuery(sql, args){
            if(sql.indexOf('SELECT COUNT(*) AS n FROM escrows') === 0) return [{ n: rows.length }];
            if(sql.indexOf('FROM escrows e') !== -1 && sql.indexOf('GROUP BY e.tick_id') !== -1){
                let total = '0';
                for(const r of rows) total = UTIL.bcstr(UTIL.bcadd(total, r.amount, 64));
                return [{ tick: 'ALPHA', total: total }];
            }
            if(sql.indexOf('FROM escrows e') !== -1) return rows;
            if(sql.indexOf('FROM order_matches') !== -1) return matches[args[0]] ? [matches[args[0]]] : [];
            if(sql.indexOf('SELECT addr.address AS address FROM actions a') === 0)
                return sources[args[0]] ? [{ address: sources[args[0]] }] : [];
            if(sql.indexOf('FROM escrow_leaf_journal') !== -1) return [];     // empty journal
            throw new Error('synthetic stub: unexpected query: ' + sql.slice(0, 70));
        }
    };
}

async function runSynthetic(sizes){
    console.log('# synthetic arming replay (stub db; a FLOOR, no per-row DB round trips)');
    console.log('# rows        ms       ms/row    keys written');
    for(const n of sizes){
        if(!Number.isInteger(n) || n <= 0){ console.error('bad size: ' + n); continue; }
        const db = syntheticDb(n);
        const t0 = process.hrtime.bigint();
        const written = await EJW.writeEscrowJournal(db, 1, { full: true, dryRun: true });
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        console.log('  ' + String(n).padEnd(10) + ms.toFixed(0).padEnd(9) +
                    (ms / n).toFixed(4).padEnd(10) + written);
    }
    console.log('\n# Read this as a floor. On a real ledger EVERY recipient-keyed release row');
    console.log('# (nine of the 26 escrow sites) costs a resolver query plus a source lookup,');
    console.log('# and every distinct key costs a journal read, all sequential inside the');
    console.log('# arming block transaction. --db mode is the only way to see that term.');
}

async function runDb(opts){
    // Credentials come from the service environment exactly as the Stage A bench
    // and src/migrate.js read them: never from the command line, never printed.
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
    const cfg = config.getConfig(opts.chain, opts.network);
    const db  = new Database(host, port, name, user, pass, { config: cfg, util: new Utility(cfg) });

    const counts = await db.doQuery(
        'SELECT COUNT(*) AS rows_total, COUNT(DISTINCT tick_id) AS ticks FROM escrows', []);
    const byAction = await db.doQuery(
        'SELECT ia.action AS action, COUNT(*) AS n FROM escrows e ' +
        'INNER JOIN actions a ON a.action_index = e.action_index ' +
        'INNER JOIN index_actions ia ON ia.id = a.action_id GROUP BY ia.action ORDER BY n DESC', []);
    console.log('# ' + opts.db + ': ' + counts[0].rows_total + ' escrow rows across ' +
                counts[0].ticks + ' tick(s)');
    console.log('# rows by action type (each must have a frozen attribution rule):');
    for(const r of byAction){
        const known = EJW.SELF_ATTRIBUTING.has(r.action) ? 'self' : (EJW.RESOLVERS[r.action] ? 'resolved' : 'UNCLASSIFIED');
        console.log('#   ' + String(r.action).padEnd(20) + String(r.n).padStart(8) + '  ' + known);
    }

    // PRE-FLIGHT, because db.doQuery collapses a NON-transactional query error
    // into [] (it re-throws only inside a transaction, which is where the real
    // writer runs, so the consensus path is fail-loud and this is a
    // tool-honesty problem rather than a writer one). A missing
    // escrow_leaf_journal makes every prior-value read look like "no prior row",
    // and a tool that printed CONFORMANCE PASSED over a swallowed error would be
    // worse than useless. It is NOT a reason to refuse: on an unarmed chain the
    // journal is empty by definition, so missing and empty give the identical
    // replay answer. Say which one it was, and let the run proceed.
    const jt = await db.doQuery(
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() ' +
        "AND table_name = 'escrow_leaf_journal'", []);
    const journalPresent = !!(jt && jt.length && Number(jt[0].n) === 1);
    if(!journalPresent)
        console.log('# NOTE escrow_leaf_journal is absent here (migration not applied). The replay is\n' +
                    '#      unaffected: an unarmed chain has an empty journal by definition, so the\n' +
                    '#      prior-value reads are correctly empty either way. Row counts below are\n' +
                    '#      "against an empty journal", which is what an arming block would face.');

    const t0 = process.hrtime.bigint();
    // READ-ONLY: dryRun does the attribution, the accumulation and every
    // fail-loud check, and writes nothing.
    const would = await EJW.writeEscrowJournal(db, 0, { full: true, dryRun: true });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const rows = Number(counts[0].rows_total) || 1;
    console.log('# replay: ' + ms.toFixed(0) + ' ms  (' + (ms / rows).toFixed(3) + ' ms/row), ' +
                would + ' journal row(s) would be written' +
                (journalPresent ? '' : ' (against an empty journal)'));
    console.log('# CONFORMANCE: attribution total, join integrity, non-negativity and the');
    console.log('#   per-tick cross-check against SUM(escrows) all PASSED on real data.');
    console.log('# nothing was written (dry run)');
    if(db.close) await db.close();
}

(async () => {
    const opts = parseArgs(process.argv);
    if(opts.db) await runDb(opts);
    else        await runSynthetic(opts.synthetic);
})().catch(e => { console.error(e); process.exit(1); });

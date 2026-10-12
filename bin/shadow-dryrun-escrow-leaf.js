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
 * SOURCE-SIDE shadow dry run for the XCHAIN_ESC locked leaf (SPV sub-tree
 * Stage B, run before arming).
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. Safe arming asks for a shadow window in which BOTH
 * TWINS derive the would-be root for N blocks and are compared. That needs a
 * live follower replaying the same chain, which is an operational venue, not a
 * script. This harness covers the half that does NOT need one, entirely
 * READ-ONLY against a real indexer database:
 *
 *   1. Replays the writer BLOCK BY BLOCK over the chain's real history, through
 *      an in-memory journal overlay, so the INCREMENTAL path (the one that runs
 *      on every block forever) is exercised against production-shaped data
 *      rather than a stub.
 *   2. Runs the ARMING REPLAY over the same ledger.
 *   3. Asserts the two agree key for key. This is the incremental-equals-full
 *      property that the unit vectors pin on synthetic rows, checked here on a
 *      real ledger where the action mix, the tick count and the release
 *      lifecycles are whatever the chain actually did.
 *   4. Builds the would-be balances_root WITH the locked leaves and reports it
 *      next to the committed one, proving the leaf set differs (the derivation
 *      is not a no-op) while nothing was written.
 *
 * A DISAGREEMENT IN (3) IS A FORK IN WAITING: the arming block would commit one
 * set and every subsequent block would maintain the other.
 *
 * The cross-twin half remains outstanding and cannot be faked here; it needs an
 * indexer and a sync follower on one chain, with both shadow columns compared.
 *
 * USAGE (on a host that runs the indexer, with its service env loaded)
 *   node bin/shadow-dryrun-escrow-leaf.js --db XChain_BTC_Regtest_Indexer --chain BTC --network regtest
 *
 * Credentials come from the service environment, never the command line.
 * Nothing is written: no journal row, no SMT node, no root.
 *
 *********************************************************************/

'use strict';

const EJW = require('../src/consensus/escrow_journal_writer.js');
const ESC = require('../src/consensus/escrow_leaf_subtree.js');
const SC  = require('../src/state_commitment/index.js');
const M   = require('../src/consensus/merkle.js');

function parseArgs(argv){
    const out = { db: null, chain: 'BTC', network: 'regtest', from: null, to: null };
    for(let i = 2; i < argv.length; i++){
        switch(argv[i]){
            case '--db':      out.db      = argv[++i]; break;
            case '--chain':   out.chain   = String(argv[++i] || '').toUpperCase(); break;
            case '--network': out.network = argv[++i]; break;
            case '--from':    out.from    = parseInt(argv[++i], 10); break;
            case '--to':      out.to      = parseInt(argv[++i], 10); break;
            case '-h': case '--help':
                console.log(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]);
                process.exit(0);
                break;
            default: console.error('unknown arg: ' + argv[i]); process.exit(64);
        }
    }
    if(!out.db){ console.error('--db <database> is required'); process.exit(64); }
    return out;
}

// Wrap a real Database so journal WRITES land in memory and journal READS come
// back from it, leaving every other query untouched and read-only. This is what
// lets the incremental path be replayed over history without touching the DB.
function journalOverlay(db){
    const rows = [];                       // {address_id, tick_id, address, tick, locked_amount, block_index, id}
    const addresses = new Map();           // index id -> canonical string
    const ticks = new Map();               // index id -> canonical string
    let nextId = 1;
    // BOTH readers are wrapped. The writer inserts through doQuery while the
    // reader (escrow_leaf_subtree.js) reads through doQueryStrict, so
    // wrapping only one leaves the other talking to the real database: the
    // reads would then miss every overlaid row and the harness would report a
    // clean "incremental equals replay" over two empty sets.
    const realQuery  = db.doQuery.bind(db);
    const realStrict = db.doQueryStrict ? db.doQueryStrict.bind(db) : realQuery;
    const overlay = async function(sql, args, passthrough){
        if(sql.indexOf('INSERT INTO escrow_leaf_journal') === 0){
            for(let i = 0; i < args.length; i += 4){
                const addressId = args[i], tickId = args[i + 1];
                rows.push({ id: nextId++, address_id: addressId, tick_id: tickId,
                            address: addresses.get(String(addressId)), tick: ticks.get(String(tickId)),
                            locked_amount: args[i + 2], block_index: args[i + 3] });
            }
            return [];
        }
        if(sql.indexOf('FROM escrow_leaf_journal') !== -1){
            // Latest row per key (MAX(id) over ALL rows, tombstones included).
            if(sql.indexOf('ORDER BY j.id DESC LIMIT 1') !== -1){
                let best = null;
                for(const r of rows){
                    if(r.address !== args[0] || r.tick !== args[1]) continue;
                    if(args.length === 3 && r.block_index > args[2]) continue;
                    if(!best || r.id > best.id) best = r;
                }
                return best ? [{ locked_amount: best.locked_amount }] : [];
            }
            if(sql.indexOf('SELECT DISTINCT') === 0){
                const seen = new Map();
                for(const r of rows)
                    if(r.block_index === args[0]) seen.set(r.address + '\t' + r.tick, { address: r.address, tick: r.tick });
                return Array.from(seen.values());
            }
            // Latest rows by index-id pair for the writer's set-based prior read.
            const max = new Map();
            for(const r of rows){
                const k = String(r.address_id) + '\t' + String(r.tick_id);
                const cur = max.get(k);
                if(!cur || r.id > cur.id) max.set(k, r);
            }
            if(sql.indexOf('SELECT j.address_id AS address_id') === 0){
                const asked = new Set(args.map(String));
                return Array.from(max.values())
                    .filter(r => asked.has(String(r.address_id)) && asked.has(String(r.tick_id)))
                    .map(r => ({ address_id: r.address_id, tick_id: r.tick_id, locked_amount: r.locked_amount }));
            }
            // Live set for the escrow-leaf reader.
            return Array.from(max.values()).map(r => ({ address: r.address, tick: r.tick, locked_amount: r.locked_amount }));
        }
        const result = await passthrough(sql, args);
        if(sql.indexOf('FROM index_addresses a WHERE a.address IN') !== -1)
            for(const r of (result || [])) addresses.set(String(r.id), String(r.address));
        if(sql.indexOf('FROM index_tickers t WHERE t.tick IN') !== -1)
            for(const r of (result || [])) ticks.set(String(r.id), String(r.tick));
        return result;
    };
    db.doQuery       = async (sql, args) => overlay(sql, args, realQuery);
    db.doQueryStrict = async (sql, args) => overlay(sql, args, realStrict);
    return { rows, reset(){ rows.length = 0; nextId = 1; } };
}

// Live (key -> amount) from a set of journal rows, applying the tombstone rule.
function liveSet(rows){
    const max = new Map();
    for(const r of rows){
        const k = r.address + '\t' + r.tick;
        const cur = max.get(k);
        if(!cur || r.id > cur.id) max.set(k, r);
    }
    const live = new Map();
    for(const [k, r] of max) if(r.locked_amount != null) live.set(k, String(r.locked_amount));
    return live;
}

// The dry run's core: replay `blocks` through the writer's incremental path, then run
// the arming replay from a clean journal, and list every key the two disagree on.
// `overlay` is the journalOverlay(db) the writer is reading and writing through.
async function compareIncrementalToReplay(db, overlay, blocks, hi){
    const t0 = process.hrtime.bigint();
    let written = 0;
    for(const b of blocks) written += await EJW.writeEscrowJournal(db, b);
    const incMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const incremental = liveSet(overlay.rows);

    overlay.reset();
    const t1 = process.hrtime.bigint();
    const replayWrote = await EJW.writeEscrowJournal(db, hi, { full: true });
    const repMs = Number(process.hrtime.bigint() - t1) / 1e6;
    const replay = liveSet(overlay.rows);

    const mismatches = [];
    for(const [k, v] of replay){
        const other = incremental.get(k);
        if(other === undefined) mismatches.push('MISSING from incremental: ' + k + ' = ' + v);
        else if(M.canonicalAmount(other) !== M.canonicalAmount(v))
            mismatches.push('DIVERGENT ' + k + ': incremental ' + other + ' vs replay ' + v);
    }
    for(const k of incremental.keys())
        if(!replay.has(k)) mismatches.push('EXTRA in incremental: ' + k);
    return { written, replayWrote, incMs, repMs, incremental, replay, mismatches };
}

async function main(argv){
    const opts = parseArgs(argv);
    const Database = require('../src/db');
    const config   = require('../src/config.js');
    const Utility  = require('../src/utility.js');
    const host = process.env.INDEXER_DB_HOST, port = process.env.INDEXER_DB_PORT;
    const user = process.env.INDEXER_DB_USER, pass = process.env.INDEXER_DB_PASS;
    if(!host || !user){
        console.error('load the service .env first (INDEXER_DB_HOST / INDEXER_DB_USER)');
        process.exit(2);
    }
    const cfg = config.getConfig(opts.chain, opts.network);
    const db  = new Database(host, port, opts.db, user, pass, { config: cfg, util: new Utility(cfg) });

    // Block range that actually wrote escrow rows: replaying empty blocks proves
    // nothing and on a long chain would dominate the runtime.
    const span = await db.doQuery(
        'SELECT MIN(a.block_index) AS lo, MAX(a.block_index) AS hi, COUNT(*) AS n ' +
        'FROM escrows e INNER JOIN actions a ON a.action_index = e.action_index', []);
    if(!span.length || span[0].n == null || Number(span[0].n) === 0){
        console.log('# ' + opts.db + ': no escrow rows; nothing to shadow');
        if(db.close) await db.close();
        process.exit(1);
        return;
    }
    const lo = (opts.from != null) ? opts.from : Number(span[0].lo);
    const hi = (opts.to   != null) ? opts.to   : Number(span[0].hi);
    console.log('# ' + opts.db + ': ' + span[0].n + ' escrow rows in blocks ' + lo + '..' + hi);

    const overlay = journalOverlay(db);

    // (1)-(3): incremental path, arming replay, and the key-for-key assertion.
    const touchedBlocks = await db.doQuery(
        'SELECT DISTINCT a.block_index AS b FROM escrows e ' +
        'INNER JOIN actions a ON a.action_index = e.action_index ' +
        'WHERE a.block_index BETWEEN ? AND ? ORDER BY a.block_index ASC', [lo, hi]);
    const cmp = await compareIncrementalToReplay(db, overlay, touchedBlocks.map(r => Number(r.b)), hi);
    console.log('# incremental: ' + touchedBlocks.length + ' block(s), ' + cmp.written + ' journal row(s), ' +
                cmp.incMs.toFixed(0) + ' ms -> ' + cmp.incremental.size + ' live locked key(s)');
    console.log('# replay:      ' + cmp.replayWrote + ' journal row(s), ' + cmp.repMs.toFixed(0) + ' ms -> ' +
                cmp.replay.size + ' live locked key(s)');
    for(const m of cmp.mismatches) console.error('  ' + m);
    const bad = cmp.mismatches.length;
    if(bad){
        console.error('# FAIL: ' + bad + ' key(s) disagree between the incremental path and the arming replay');
        if(db.close) await db.close();
        process.exit(1);
    }
    console.log('# OK: incremental and arming replay agree on all ' + cmp.replay.size + ' live key(s)');

    // (4) The would-be balances_root, next to the committed one. In-memory node
    // store: not one SMT node is persisted.
    const smt = new SC.PersistentSMT(new SC.MemoryNodeStore());
    let root = SC.EMPTY_ROOT_HEX;
    const bals = await db.doQuery(
        `SELECT a.address AS address, t.tick AS tick, CAST(SUM(s.amt) AS CHAR) AS net FROM (
            SELECT address_id, tick_id,  CAST(amount AS DECIMAL(60,18)) AS amt FROM credits
            UNION ALL
            SELECT address_id, tick_id, -CAST(amount AS DECIMAL(60,18)) AS amt FROM debits
         ) s
         INNER JOIN index_addresses a ON a.id=s.address_id
         INNER JOIN index_tickers   t ON t.id=s.tick_id
         GROUP BY s.address_id, s.tick_id HAVING SUM(s.amt) <> 0`, []);
    for(const r of bals){
        if(r.address == null || r.tick == null) continue;
        const canon = M.canonicalAmount(String(r.net));
        if(canon === M.canonicalAmount('0')) continue;
        root = await smt.update(root, M.balanceKey(opts.chain, opts.network, r.address, r.tick), M.toHex(M.leafHash(canon)));
    }
    const v1Root = root;
    for(const e of await ESC.liveEscrowLeaves(db))
        root = await smt.update(root, M.escrowKey(opts.chain, opts.network, e.address, e.tick), e.leaf);
    console.log('# balances_root v1 (spendable only): ' + v1Root);
    console.log('# balances_root WITH locked leaves : ' + root);
    console.log(root === v1Root
        ? '# NOTE identical: this chain holds nothing locked, so the leaf set is unchanged'
        : '# differs, as it must: arming this chain would move balances_root');
    if(root === v1Root){
        if(db.close) await db.close();
        process.exit(1);
    }

    const committed = await db.doQuery(
        'SELECT balances_root FROM state_tree_roots WHERE chain=? AND network=? ORDER BY block_index DESC LIMIT 1',
        [opts.chain, opts.network]);
    if(committed.length)
        console.log('# committed balances_root at tip: ' + committed[0].balances_root +
                    (committed[0].balances_root === v1Root ? '  (matches the v1 rebuild)' : '  (differs: tip moved since the rebuild read)'));
    console.log('# nothing was written: no journal row, no SMT node, no root');
    if(db.close) await db.close();
}

module.exports = { journalOverlay, liveSet, compareIncrementalToReplay, main };

if(require.main === module)
    main(process.argv).catch(e => { console.error(e); process.exit(1); });

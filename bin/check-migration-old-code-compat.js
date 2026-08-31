#!/usr/bin/env node
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
 *
 * Prove that the migrations pending against a DEPLOYED ref are additive and
 * old-code-compatible, before they are applied to anything that matters.
 *
 * The migration-compatibility gate (spec §7) requires: "every pre-window migration
 * proven additive and old-code-compatible (old suite green against the migrated
 * schema)". Driven by bin/check-migration-old-code-compat.sh, which provisions
 * the throwaway database; this file is the assertions.
 *
 * WHY NOT JUST RUN THE OLD SUITE
 * ------------------------------
 * Because it would not test the migration. The DB-backed tiers BUILD their own
 * schema from src/sql at setup, so the old suite run against its own fresh
 * schema never meets a migrated one, and would report green whatever the
 * migration did. The gate's wording describes the intent; this is the operation
 * that actually has the property.
 *
 * WHAT IT SIMULATES: §8 step 2, exactly
 * -------------------------------------
 *   1. build the schema for the affected tables AT THE DEPLOYED REF and populate
 *      it, so pre-existing rows are in the picture,
 *   2. seed `schema_migrations` the way that host's ledger really looks, so the
 *      pending set is the host's pending set and not "all of them",
 *   3. run the REAL runMigrations({includeManual:true}) from the batch tree, the
 *      same code path src/migrate.js drives, and
 *   4. run OLD code's statements against the migrated schema.
 *
 * Step 4 is the point. Between §8 step 2 (migrate) and step 4 (halt), the
 * migrated schema is being served by code that predates it, so old statements
 * are the deployed reality and the thing that must not break.
 *
 * THE OLD-STATEMENT SET IS MAINTAINED, NOT DISCOVERED
 * ---------------------------------------------------
 * OLD_STATEMENTS below is keyed by table and holds statements copied verbatim
 * out of `git show <ref>:src/db.js`. It is deliberately not generated: the
 * point is to exercise what old code really sends, and a generator would either
 * re-derive it from the NEW code (wrong tree) or invent plausible SQL (proves
 * nothing). When a migration touches a table with no entry here, the run FAILS
 * rather than passing silently, because a green run over a table nobody wrote
 * statements for is the false green this whole gate exists to avoid.
 *
 * Env: DB_HOST DB_PORT DB_USER DB_PASS DB_NAME OLD_REF REPO
 */

'use strict';

const { execFileSync } = require('child_process');
const crypto           = require('crypto');
const path             = require('path');
const fs               = require('fs');

const REPO    = process.env.REPO || path.join(__dirname, '..');
const OLD_REF = process.env.OLD_REF;
const DB_NAME = process.env.DB_NAME;

if(!OLD_REF || !DB_NAME || !process.env.DB_HOST){
    console.error('check-migration-old-code-compat: OLD_REF, DB_NAME and DB_HOST are required ' +
                  '(run it through bin/check-migration-old-code-compat.sh).');
    process.exit(2);
}

const Database = require(path.join(REPO, 'src/db.js'));
const config   = require(path.join(REPO, 'src/config.js'));
const Utility  = require(path.join(REPO, 'src/utility.js'));

// Statements copied verbatim from the OLD tree. Extend this when a migration
// touches a table that is not listed; an unlisted affected table fails the run.
const OLD_STATEMENTS = {
    gated_files: {
        insert: 'INSERT INTO gated_files (action_index, gate_ticker, encryption_method, key_hash, status_id, raw_data) values (?, ?, ?, ?, ?, ?)',
        update: 'UPDATE gated_files SET gate_ticker=?, encryption_method=?, key_hash=?, status_id=?, raw_data=? WHERE action_index=?',
        exists: 'SELECT action_index FROM gated_files WHERE action_index=?',
        rawFetch: 'SELECT raw_data FROM gated_files WHERE action_index=? LIMIT 1',
        activeHashes: `SELECT DISTINCT gf.key_hash
                 FROM gated_files gf
                 INNER JOIN index_statuses s ON s.id = gf.status_id
                 WHERE gf.gate_ticker = ?
                   AND s.status = 'valid'`,
    },
    state_checkpoints: {
        insert: `INSERT INTO state_checkpoints (chain, network, block_index, block_hash, ledger_hash,
                     actions_hash, contract_hash, checkpoint_seq, snapshot_block, validator_signatures)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
    },
    // From the pre-ANCHOR-v7 db.createAnchorAction. It names no section_index and keys
    // the exists-probe / UPDATE on action_index alone, which is exactly what the
    // (action_index, section_index) primary key must not break: the added column has to
    // carry a usable DEFAULT for the INSERT, and the widened key must still admit an old
    // writer's single row per action.
    anchor_actions: {
        insert: `INSERT INTO anchor_actions
                        (version, chain, network, block_index, block_hash, ledger_hash, actions_hash,
                         contract_hash, checkpoint_seq, snapshot_block, state_root, state_root_version,
                         block_merkle_root, block_merkle_version, match_batch_seq, match_count,
                         batch_crc32, total_chunks, chunk_index, archive_b64, validator_signatures,
                         publisher, publisher_attestations,
                         status_id, block_index_doge, action_index)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        update: `UPDATE anchor_actions SET version=?, chain=?, network=?, block_index=?, block_hash=?,
                        ledger_hash=?, actions_hash=?, contract_hash=?, checkpoint_seq=?, snapshot_block=?,
                        state_root=?, state_root_version=?, block_merkle_root=?, block_merkle_version=?,
                        match_batch_seq=?, match_count=?, batch_crc32=?, total_chunks=?, chunk_index=?,
                        archive_b64=?, validator_signatures=?, publisher=?, publisher_attestations=?,
                        status_id=?, block_index_doge=?
                 WHERE action_index=?`,
        exists: 'SELECT action_index FROM anchor_actions WHERE action_index=? LIMIT 1',
        maxSeq: `SELECT MAX(a.checkpoint_seq) AS max_seq
                   FROM anchor_actions a
                   JOIN index_statuses s ON s.id = a.status_id
                  WHERE a.chain = ? AND a.network = ?
                    AND s.status IN ('valid', 'unverified')`,
    },
    // From `git show b5c8fcf:src/stateCommitment.js` (the ref six of the fleet's nine
    // indexers were running on 2026-07-29). Seven columns named, so the migrations
    // that add contract_state_root and the escrow shadow column have to be
    // nullable or defaulted for this to keep working.
    state_tree_roots: {
        insert: `INSERT INTO state_tree_roots
                    (chain, network, block_index, balances_root, stakes_root, state_root, block_merkle_root)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    balances_root=VALUES(balances_root), stakes_root=VALUES(stakes_root),
                    state_root=VALUES(state_root), block_merkle_root=VALUES(block_merkle_root)`,
        priorRoot: 'SELECT balances_root FROM state_tree_roots WHERE chain=? AND network=? AND block_index=? LIMIT 1',
    },
};

function git(...args){
    return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// Use the PRODUCT's comment stripper, not a second implementation. A local regex
// here got this wrong twice over: stripping only whole comment lines split a
// CREATE TABLE in half on a semicolon inside a trailing column comment
// ("state_root; NULL pre flag-day"), and even the fixed regex was not
// quote-aware, so a `--` inside a quoted DDL string would be eaten. db.js's
// version handles both, and its comment names the exact hazard ("so a ';'
// appearing inside comment prose is never mistaken for a statement terminator").
const stripSqlLineComments = Database.prototype.stripSqlLineComments;

function statements(sql){
    return stripSqlLineComments(sql).split(';').map(s => s.trim()).filter(s => s.length > 0);
}

// Tables a migration file touches, split two ways because the two need different
// treatment:
//
//   written    - altered, indexed or written by the migration. These drive the
//                OLD_STATEMENTS requirement and the assertions.
//   referenced - only READ by it. A data-backfill joins tables it never writes
//                (2026-07-26-tokens-backfill-lock-mint-supply reads `issues`), and
//                those must merely EXIST or the migration dies with errno 1146. They
//                are deliberately NOT in `written`: exercising old statements against
//                a table the migration only reads would prove nothing.
//
// Coarse on purpose: over-reporting into `written` costs a loud missing-statement
// failure, while under-reporting would skip the statements that matter.
function tablesTouched(sql){
    const body       = stripSqlLineComments(sql);
    const written    = new Set();
    const referenced = new Set();
    for(const m of body.matchAll(/\b(?:ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX[\s\S]*?\bON|INSERT\s+INTO|UPDATE|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+`?([a-z_][a-z0-9_]*)`?/gi))
        written.add(m[1].toLowerCase());
    // The fence migration builds its DDL as strings inside SET @var = (SELECT IF(...)),
    // so the table name only ever appears inside a quoted literal.
    for(const m of body.matchAll(/TABLE_NAME\s*=\s*'([a-z_][a-z0-9_]*)'/gi))
        written.add(m[1].toLowerCase());
    for(const m of body.matchAll(/\b(?:FROM|JOIN)\s+`?([a-z_][a-z0-9_]*)`?/gi)){
        const t = m[1].toLowerCase();
        if(t !== 'information_schema' && t !== 'dual' && !written.has(t)) referenced.add(t);
    }
    return { written: [...written], referenced: [...referenced] };
}

const results = [];
async function check(name, fn){
    try { results.push({ ok: true, name, detail: (await fn()) || '' }); }
    catch(e){ results.push({ ok: false, name, detail: (e && e.message) || String(e) }); }
}

async function main(){
    const cfg = config.getConfig();
    const db  = new Database(process.env.DB_HOST, process.env.DB_PORT, DB_NAME,
                             process.env.DB_USER, process.env.DB_PASS,
                             { config: cfg, util: new Utility(cfg) });

    // db.doQuery swallows a query error into [] outside a transaction, which would
    // make this harness report success on statements that never ran. Everything here
    // goes through a raw connection so a failure throws.
    const raw = async (sql, args) => {
        const conn = await db.getConnection();
        try { return await conn.query(sql, args); }
        finally { await conn.release(); }
    };

    const mode = await raw('SELECT @@SESSION.sql_mode AS s');
    console.log('sql_mode: ' + mode[0].s);
    await check('the run is under STRICT_TRANS_TABLES, so a NOT NULL DEFAULT check means something', async () => {
        if(!/STRICT_TRANS_TABLES/.test(String(mode[0].s)))
            throw new Error('session sql_mode is not strict: ' + mode[0].s);
        return String(mode[0].s);
    });

    // ── Which migrations are pending against OLD_REF, and what do they touch ──────
    const oldFiles = git('ls-tree', '--name-only', OLD_REF + ':src/sql/migrations')
                        .split('\n').map(s => s.trim()).filter(s => s.endsWith('.sql'));
    const nowFiles = fs.readdirSync(path.join(REPO, 'src/sql/migrations'))
                       .filter(f => f.endsWith('.sql')).sort();
    const pending  = nowFiles.filter(f => !oldFiles.includes(f));
    if(!pending.length){
        console.log('nothing pending against ' + OLD_REF + ': the ref already carries every migration.');
        process.exit(0);
    }
    console.log('pending against ' + OLD_REF + ': ' + pending.join(', '));

    const parsed     = pending.map(f => tablesTouched(fs.readFileSync(path.join(REPO, 'src/sql/migrations', f), 'utf8')));
    const affected   = [...new Set(parsed.flatMap(p => p.written))].sort();
    const referenced = [...new Set(parsed.flatMap(p => p.referenced))].filter(t => !affected.includes(t)).sort();
    console.log('tables written: ' + affected.join(', '));
    if(referenced.length) console.log('tables only read (built so the migration can run): ' + referenced.join(', '));

    // A table the pending set CREATES is exempt, and getting this wrong was a real bug:
    // the guard demanded old statements for `escrow_leaf_journal`, a table introduced by
    // one of the pending migrations. Old code cannot reference a table that does not
    // exist at its ref, so the requirement was unsatisfiable and failed the gate for the
    // one class of migration that is trivially old-code-safe. Tables the pending set
    // ALTERs still need statements: those old code does touch.
    const created = new Set();
    for(const f of pending){
        const body = stripSqlLineComments(fs.readFileSync(path.join(REPO, 'src/sql/migrations', f), 'utf8'));
        for(const m of body.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`?([a-z_][a-z0-9_]*)`?/gi))
            created.add(m[1].toLowerCase());
    }
    const mustExercise = affected.filter(t => !created.has(t));
    if(created.size) console.log('created by the pending set (exempt): ' + [...created].join(', '));

    await check('every affected table old code can touch has an OLD_STATEMENTS entry', async () => {
        const missing = mustExercise.filter(t => !OLD_STATEMENTS[t]);
        if(missing.length)
            throw new Error('no old statements recorded for: ' + missing.join(', ') +
                            '. Add them from `git show ' + OLD_REF + ':src/**` rather than ' +
                            'letting this run pass over a table nobody wrote statements for.');
        return mustExercise.join(', ') + (created.size ? '  (exempt, created here: ' + [...created].join(', ') + ')' : '');
    });

    // ── Build the affected tables AT THE OLD REF ─────────────────────────────────
    // index_statuses first and always: the status join is how "active" is resolved
    // for several of these tables, so a run without it fails on the join, not on
    // anything the migration did.
    for(const f of ['index_statuses.sql', ...affected.map(t => t + '.sql'), ...referenced.map(t => t + '.sql')]){
        let ddl;
        try { ddl = git('show', OLD_REF + ':src/sql/' + f); }
        catch(e){ console.log('  (no ' + f + ' at ' + OLD_REF + ', skipping)'); continue; }
        for(const s of statements(ddl)) await raw(s);
        console.log('  built ' + f + ' @ ' + OLD_REF);
    }

    await check('the starting schema really is the OLD one, so the rest measures the right delta', async () => {
        // One placeholder per table. A single `IN (?)` bound to a joined string matches
        // NOTHING, which made this check pass over an empty result set: green because it
        // examined nothing, the exact false-green shape this whole gate is about.
        const cols = await raw(
            `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${affected.map(() => '?').join(', ')})`,
            [DB_NAME, ...affected]);
        if(!cols.length) throw new Error('read no columns for ' + affected.join(', ') + '; the tables were not built');
        const before = {};
        for(const c of cols) (before[c.TABLE_NAME] = before[c.TABLE_NAME] || []).push(c.COLUMN_NAME);
        // Assert positively: each pending ALTER's target column must be ABSENT now.
        for(const f of pending){
            const body = fs.readFileSync(path.join(REPO, 'src/sql/migrations', f), 'utf8');
            for(const m of body.matchAll(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+`?([a-z_][a-z0-9_]*)`?/gi)){
                const col = m[1].toLowerCase();
                for(const t of Object.keys(before))
                    if(before[t].map(c => c.toLowerCase()).includes(col))
                        throw new Error(t + ' already has ' + col + ' before migrating');
            }
        }
        return Object.entries(before).map(([t, c]) => t + '(' + c.length + ' cols)').join(' ');
    });

    // ── Populate, so the migrations meet existing data ───────────────────────────
    await raw(`INSERT INTO index_statuses (status) VALUES ('valid')`);
    const validId = Number((await raw(`SELECT id FROM index_statuses WHERE status='valid' LIMIT 1`))[0].id);
    const KH = 'a'.repeat(64);
    if(OLD_STATEMENTS.gated_files && affected.includes('gated_files')){
        await raw(OLD_STATEMENTS.gated_files.insert, [1001, 'PEPECREATURE', 1, KH, validId, Buffer.from('ciphertext-1')]);
        await raw(OLD_STATEMENTS.gated_files.insert, [1002, 'PEPECREATURE', 1, KH, validId, Buffer.from('ciphertext-2')]);
    }
    if(OLD_STATEMENTS.state_checkpoints && affected.includes('state_checkpoints'))
        await raw(OLD_STATEMENTS.state_checkpoints.insert,
                  ['BTC', 'regtest', 500, 'h', 'l', 'a', 'c', 900000, 900000]);
    const H64 = 'c'.repeat(64);
    if(OLD_STATEMENTS.anchor_actions && affected.includes('anchor_actions'))
        await raw(OLD_STATEMENTS.anchor_actions.insert,
                  [1, 'BTC', 'regtest', 500, H64, H64, H64, H64, 900000, 900000,
                   null, null, null, null, 0, 1, 'deadbeef', 1, null, 'Zm9v', '[]',
                   null, null, validId, 700, 5001]);
    const ROOT = 'b'.repeat(64);
    if(OLD_STATEMENTS.state_tree_roots && affected.includes('state_tree_roots'))
        await raw(OLD_STATEMENTS.state_tree_roots.insert,
                  ['BTC', 'regtest', 500, ROOT, ROOT, ROOT, ROOT]);

    // ── Seed the ledger as the deployed host's really looks ──────────────────────
    {
        const conn = await db.getConnection();
        // The product's own ledger DDL, not a copy: a hand-written copy omitted the
        // `mode` column and the migrator then failed on its own bookkeeping insert.
        try { await db._ensureMigrationsLedger(conn); }
        finally { await conn.release(); }
    }
    for(const f of oldFiles){
        const body = git('show', OLD_REF + ':src/sql/migrations/' + f);
        await raw('INSERT INTO schema_migrations (name, checksum, mode, applied_at) VALUES (?, ?, ?, NOW())',
                  [f, crypto.createHash('sha256').update(body).digest('hex'),
                   /mode=auto/.test(body) ? 'auto' : 'manual']);
    }
    console.log('ledger seeded with ' + oldFiles.length + ' already-applied migrations');

    // ── The operation under test ─────────────────────────────────────────────────
    const res = await db.runMigrations({ includeManual: true });
    if(res.lockSkipped) throw new Error('migrator skipped on the advisory lock; nothing was examined');

    await check('the migrator applied exactly the set pending against ' + OLD_REF, async () => {
        const applied = (res.applied || []).map(a => (typeof a === 'string' ? a : a.name || a.file)).sort();
        if(JSON.stringify(applied) !== JSON.stringify(pending.slice().sort()))
            throw new Error('applied ' + JSON.stringify(applied) + ', pending was ' + JSON.stringify(pending));
        return applied.join(', ');
    });

    await check('added columns are additive: pre-existing rows survive on their declared defaults', async () => {
        const notes = [];
        for(const f of pending){
            const body = fs.readFileSync(path.join(REPO, 'src/sql/migrations', f), 'utf8');
            for(const m of body.matchAll(/ALTER\s+TABLE\s+`?([a-z_][a-z0-9_]*)`?[\s\S]*?ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+`?([a-z_][a-z0-9_]*)`?([^;]*)/gi)){
                const [table, col, tail] = [m[1].toLowerCase(), m[2].toLowerCase(), m[3]];
                const rows = await raw('SELECT `' + col + '` AS v FROM `' + table + '`');
                if(!rows.length) continue;
                const wantNull = /\bNULL\b/i.test(tail) && !/NOT\s+NULL/i.test(tail);
                // Quoted OR bare: a numeric default is written unquoted (`DEFAULT 0`), and
                // reading only the quoted form left every integer column's default
                // unasserted - the note then printed `=undefined` and the case passed over
                // exactly the claim it exists to make.
                const dflt     = (tail.match(/DEFAULT\s+'([^']*)'/i) ||
                                  tail.match(/DEFAULT\s+(-?\d+(?:\.\d+)?)\b/i) || [])[1];
                for(const r of rows){
                    if(wantNull && r.v !== null)
                        throw new Error(table + '.' + col + ' should be NULL on legacy rows, saw ' + JSON.stringify(r.v));
                    // Compared as strings: a numeric column comes back as a number while the
                    // declared default is parsed out of the DDL text.
                    if(dflt !== undefined && String(r.v) !== String(dflt))
                        throw new Error(table + '.' + col + ' should be the declared default ' +
                                        JSON.stringify(dflt) + ' on legacy rows, saw ' + JSON.stringify(r.v));
                }
                notes.push(table + '.' + col + '=' + (wantNull ? 'NULL' : JSON.stringify(dflt)) +
                           ' on ' + rows.length + ' legacy row(s)');
            }
        }
        return notes.length ? notes.join('; ') : 'no ADD COLUMN in the pending set';
    });

    await check('OLD statements still work against the migrated schema', async () => {
        const notes = [];
        if(affected.includes('gated_files')){
            const S = OLD_STATEMENTS.gated_files;
            // The insert names no new column, so a NOT NULL addition has to carry a
            // usable DEFAULT or this throws under strict mode.
            await raw(S.insert, [1003, 'PEPECREATURE', 1, KH, validId, Buffer.from('ciphertext-3')]);
            await raw(S.update, ['PEPECREATURE', 1, KH, validId, Buffer.from('ciphertext-1b'), 1001]);
            if((await raw(S.exists, [1001])).length !== 1) throw new Error('gated_files exists-check broke');
            if((await raw(S.rawFetch, [1001]))[0].raw_data == null) throw new Error('gated_files raw fetch broke');
            const kh = await raw(S.activeHashes, ['PEPECREATURE']);
            if(kh.length !== 1) throw new Error('gated_files active-hash query returned ' + kh.length + ' rows');
            notes.push('gated_files: insert/update/exists/raw/active-hashes all OK');
        }
        if(affected.includes('state_checkpoints')){
            // One checkpoint per seq is what old code writes in normal operation. It
            // must still be accepted, because §3.5 abort resumes old code against this
            // schema after the fence has been applied in §8 step 4a.
            await raw(OLD_STATEMENTS.state_checkpoints.insert,
                      ['BTC', 'regtest', 501, 'h2', 'l2', 'a2', 'c2', 900001, 900001]);
            notes.push('state_checkpoints: one row per seq still accepted (abort path writes normally)');
        }
        if(affected.includes('anchor_actions')){
            const S = OLD_STATEMENTS.anchor_actions;
            // The INSERT names no section_index, so the added NOT NULL column has to carry a
            // usable DEFAULT or this throws under strict mode - which is the whole
            // old-code-compatibility claim for the ANCHOR v7 primary-key change.
            await raw(S.insert, [1, 'BTC', 'regtest', 501, H64, H64, H64, H64, 900001, 900001,
                                 null, null, null, null, 1, 1, 'deadbeef', 1, null, 'Zm9v', '[]',
                                 null, null, validId, 701, 5002]);
            // The old UPDATE keys on action_index ALONE. Under the widened
            // (action_index, section_index) key it must still find and rewrite the row an
            // old writer inserted, which it does because that row is at section 0.
            await raw(S.update, [1, 'BTC', 'regtest', 501, H64, H64, H64, H64, 900001, 900001,
                                 null, null, null, null, 1, 2, 'deadbeef', 1, null, 'Zm9v', '[]',
                                 null, null, validId, 701, 5002]);
            if((await raw(S.exists, [5001])).length !== 1) throw new Error('anchor_actions exists-check broke');
            const seq = await raw(S.maxSeq, ['BTC', 'regtest']);
            if(!seq.length || Number(seq[0].max_seq) !== 900001)
                throw new Error('anchor_actions replay-watermark read broke: ' + JSON.stringify(seq));
            const sect = await raw('SELECT DISTINCT section_index AS s FROM anchor_actions');
            if(sect.length !== 1 || Number(sect[0].s) !== 0)
                throw new Error('an old writer\'s rows must all land at section 0, saw ' + JSON.stringify(sect));
            notes.push('anchor_actions: old insert/update/exists/max-seq all OK, every old row at section 0');
        }
        if(affected.includes('state_tree_roots')){
            const S = OLD_STATEMENTS.state_tree_roots;
            // Names seven columns and none of the added ones, so an added NOT NULL column
            // without a default would break the commitment write path on every block.
            await raw(S.insert, ['BTC', 'regtest', 501, ROOT, ROOT, ROOT, ROOT]);
            await raw(S.insert, ['BTC', 'regtest', 501, ROOT, ROOT, ROOT, ROOT]);   // the ON DUPLICATE path too
            const prior = await raw(S.priorRoot, ['BTC', 'regtest', 500]);
            if(!prior.length) throw new Error('state_tree_roots prior-root lookup returned nothing');
            notes.push('state_tree_roots: insert, ON DUPLICATE KEY UPDATE and prior-root lookup all OK');
        }
        return notes.join('; ');
    });

    await check('a tightened unique key still rejects what it exists to reject', async () => {
        if(!affected.includes('state_checkpoints')) return 'no tightened key in the pending set';
        const idx = [...new Set((await raw(
            `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'state_checkpoints'`, [DB_NAME]))
            .map(i => i.INDEX_NAME))];
        if(idx.includes('uq_chain_block_seq')) throw new Error('the old wide key survived: ' + idx.join(','));
        if(!idx.includes('uq_chain_seq'))      throw new Error('the tightened key is absent: ' + idx.join(','));
        try {
            // Same seq, different block_index: the split-brain row the old wide key admitted.
            await raw(OLD_STATEMENTS.state_checkpoints.insert,
                      ['BTC', 'regtest', 999, 'h3', 'l3', 'a3', 'c3', 900001, 900001]);
        } catch(e){
            if(/Duplicate entry/i.test(e.message)) return idx.join(',') + '; split-brain row rejected';
            throw e;
        }
        throw new Error('the split-brain row was ADMITTED, so the fence is inert');
    });

    await check('every applied migration is idempotent: a second run applies nothing', async () => {
        const again = await db.runMigrations({ includeManual: true });
        if((again.applied || []).length !== 0)
            throw new Error('re-run applied ' + again.applied.length + ' migration(s)');
        return 'applied 0 on re-run';
    });

    console.log('');
    let failed = 0;
    for(const r of results){
        console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name);
        if(r.detail) console.log('        ' + r.detail);
        if(!r.ok) failed++;
    }
    console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed');
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error('HARNESS ERROR: ' + ((e && e.stack) || e)); process.exit(2); });

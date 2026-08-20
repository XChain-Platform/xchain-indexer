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
 * BELOW-THE-FLAG REPLAY EQUIVALENCE for LEDGER_AMOUNT_PRECISION.
 *
 * WHY THIS EXISTS. The exact-ledger rule changes how EVERY credit, debit and escrow
 * row is quantized on the way into the database. Below the flag a row is rounded to
 * the TICK's own decimals; above it the row is stored exactly, at the platform's
 * maximum token precision, and rounding happens once at the supply and balance
 * projections. Rows are what balances are built from and balances are what
 * balances_root commits to, so if the new rule leaks below the gate, a replay of
 * history reaches balances the live fleet never wrote and the ledger forks. This
 * tool is the evidence that nothing leaks, and it is the last gate before the
 * operator may pin a mainnet height, so it may not be a code-reading argument: it
 * has to be driven, in both directions.
 *
 * ------------------------------------------------------------------------------
 * THE THREE SIDES
 *
 *   OLD - HEAD's tree with the ledger-precision work SURGICALLY REMOVED from
 *         src/db.js: every call site of the activation module is rewritten back to
 *         the expression that stood at --pre-ref, and the module file itself is
 *         deleted from the tree so a missed site cannot resolve. This is HEAD with
 *         exactly this change removed and nothing else.
 *   OFF - HEAD, with every activation height moved to the UNARMED sentinel, i.e.
 *         a block below the flag instant on every chain.
 *   ON  - HEAD, with every activation height forced to 0. This is the NEGATIVE
 *         CONTROL, not evidence.
 *
 * All three replay the SAME decoder corpus from genesis into three separate
 * databases. OLD vs OFF must be byte-identical, table for table and hash for hash.
 * ON must not be, and the run fails if it is.
 *
 * WHY OLD IS SURGICAL AND NOT A WHOLE OLD TREE. src/db.js is the busiest file in
 * the service and has taken unrelated behavioural commits since the flag landed,
 * so substituting the whole file (the shape a predecessor tool uses for a quiet
 * file) would roll those back too and the comparison would be about something
 * else. Reverse-applying the original commit is no better: a later sweep rewrote
 * comment text inside the very hunks that carry the change, so the patch no longer
 * applies and would have to be forced.
 *
 * So the old side is rebuilt from a table of exact call-site substitutions, and
 * each one is CHECKED rather than trusted:
 *
 *   - the HEAD text being replaced must occur EXACTLY ONCE in HEAD's src/db.js,
 *   - the legacy text being restored must occur VERBATIM in --pre-ref's src/db.js,
 *   - after the rewrite, src/db.js may not mention the activation module at all,
 *   - the activation module is DELETED from the old tree, so any site the table
 *     missed fails to resolve at require time instead of quietly staying modern,
 *   - the rewritten file must still parse (node --check).
 *
 * A future edit that adds a call site therefore turns this tool red rather than
 * letting it certify a partial rollback.
 *
 * WHY THE GATE IS FORCED BY MOVING THE HEIGHT AND NOT BY STUBBING THE PREDICATE:
 * the pre-flag condition IS "the activation height has not been reached". Moving
 * every registered height to the sentinel makes the REAL predicate evaluate the
 * REAL comparison and answer false the same way it answers false on mainnet today.
 * A stubbed predicate would prove that a stub returns false.
 *
 * ------------------------------------------------------------------------------
 * WHERE THE DIVERGENCE HAS TO COME FROM
 *
 * The read-side aggregation is deliberately NOT gated: the projections sum at the
 * exact scale and round once on both sides of the flag, because on rows written
 * under the legacy rule that is provably the same number. So a corpus can only
 * fork the two sides through the WRITE path, and only where an amount is FINER
 * than the tick it is denominated in.
 *
 * That is not a hypothetical corner. Fees are computed at 8 decimal places from
 * gas units times the gas price, while the gas tick on a regtest chain is issued
 * with 0 decimals, so a half-unit subtoken issuance fee is recorded truthfully in
 * `fees` and rounded UP to a whole unit in `debits`. The synthetic corpus below
 * puts exactly that shape on the chain, together with controls whose amounts sit
 * on their tick's own grid and therefore must NOT move.
 *
 * ------------------------------------------------------------------------------
 * TWO CORPORA, BECAUSE NEITHER ONE ALONE IS THE WHOLE CLAIM
 *
 *   --corpus synthetic (default): a purpose-built chain whose gas tick carries 0
 *     decimals, so every fractional fee straddles the rule. Its job is the
 *     NEGATIVE CONTROL: the divergences here are designed, so a run where ON
 *     matches OLD means this harness has gone blind and is reported as a FAILURE
 *     of the tool rather than a pass.
 *
 *   --corpus real (--decoder-db <schema>): an existing decoder schema replayed
 *     from its first block, whatever a live chain actually produced. Its job is
 *     the BYTE-IDENTICAL half over traffic nobody designed for this test.
 *
 * The synthetic shapes, each paired with a control that must NOT move:
 *
 *   S1  gas tick issued with 0 decimals   the whole reason a fee can be off-grid
 *   S2  one subtoken issuance             fee is half a unit: OLD writes a whole
 *                                         unit, ON writes the half
 *   S3  ten subtoken issuances in a batch the same error, multiplied, which is
 *                                         how it grew large enough to notice
 *   C1  a plain token issuance            fee is a whole number of gas units
 *   C2  transfers of an 8-decimal tick    amounts already on the tick's grid, so
 *                                         both rules store the same string
 *
 * C1 and C2 are what make the control TARGETED. Without them a red ON side would
 * be satisfied by a rule that simply rewrites every row.
 *
 * ------------------------------------------------------------------------------
 * NEGATIVE CONTROLS (a comparison that would pass even if the gate did nothing is
 * worthless)
 *
 *   N1. GATE STATE IS PROVEN, NOT ASSUMED. Each side reports the activation map
 *       its OWN process is running with, plus the predicate's answer at the first
 *       and last block of the corpus. The OLD side additionally proves its tree
 *       carries no reader of the flag and no flag module to read.
 *   N2. THE HARNESS DETECTS DIVERGENCE. Side ON is compared against OLD with the
 *       same comparator and MUST differ, in the tables this rule is supposed to
 *       move, and on the consensus hash chain rather than only in local rows.
 *   N3. THE WITNESSES. What each side did with the corpus is pinned directly: the
 *       gas-tick debit written for a fee-bearing action is compared against the
 *       fee the action was actually charged. On OLD that comparison must MISMATCH
 *       somewhere (the defect is present, so the corpus reaches the write path);
 *       on ON it must match everywhere (the rule is in force).
 *   N4. THE SUBSTITUTION IS EXACT AND COMPLETE. See the old-side notes above.
 *
 * ------------------------------------------------------------------------------
 * WHAT IT DOES NOT COVER - read this before quoting a green run.
 *
 *   - The read-side projections are compared as they are REACHED by this corpus.
 *     A projection no block in the corpus calls is not measured here, and the run
 *     prints its row counts so a thin corpus cannot be quoted as a broad claim.
 *   - The synthetic corpus deliberately holds one gas tick at 0 decimals. A chain
 *     whose gas tick carries 8 decimals cannot fork under this rule at all, which
 *     is a MEASUREMENT about that chain and not a property of the code; run the
 *     synthetic corpus for the control and the real one for the equivalence.
 *   - Nothing here says anything about which HEIGHT should be pinned on a network
 *     that already has history. It says only that below whatever height is pinned,
 *     the new code commits what the old code committed.
 *
 * READ-ONLY WITH RESPECT TO THE REPOSITORY. The old tree is materialized with
 * `git archive` (a pure read of the object store: no index, no worktree metadata,
 * no ref writes) into a temp dir. The tool writes only to its own throwaway
 * databases, and never to --decoder-db.
 *
 * USAGE
 *   node bin/verify-ledger-amount-precision-replay-equivalence.js
 *   node bin/verify-ledger-amount-precision-replay-equivalence.js --dry-run
 *   node bin/verify-ledger-amount-precision-replay-equivalence.js \
 *        --corpus real --decoder-db xchain_btc_regtest_dec --coin BTC --network regtest
 *
 * Needs a MariaDB the test user may CREATE schemas on:
 *   TEST_DB_HOST TEST_DB_PORT TEST_DB_USER TEST_DB_PASS (fall back to .env
 *   INDEXER_DB_* exactly like test/integration/setup/db-connection.js), and
 *   TEST_DB_NS (default xchain_test_lap) for the throwaway schema prefix.
 *
 * EXIT: 0 every assertion holds, 1 an assertion failed, 2 cannot run.
 *
 *********************************************************************/

'use strict';

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

const REPO      = path.resolve(__dirname, '..');
const GATE      = 'LEDGER_AMOUNT_PRECISION';
const FLAG_REL  = path.join('src', 'ledger_amount_precision_activation.js');
const FLAG_NAME = 'ledger_amount_precision_activation';
const UNARMED   = 9999999999;       // the house UNARMED sentinel
const SIDE_MARK = '###LAP-SIDE###'; // child -> parent report line

// --- the old side -----------------------------------------------------------
//
// One entry per call site of the activation module in src/db.js. `head` is the text
// HEAD carries and `legacy` is the text --pre-ref carried in its place. Comment lines
// are excluded from both on purpose: a comment sweep must not be able to break the
// rollback, and comments cannot change what the code commits.
//
// `restores` marks the entries whose `legacy` text is expected to appear verbatim in
// --pre-ref's src/db.js. The two entries that only DELETE a line introduced by the
// change are marked false, and are checked the other way round: their `head` text
// must be ABSENT from --pre-ref.
//
// Declared HERE, above the dispatch below, rather than beside the functions that read
// it: main() is invoked synchronously and its prefix reaches the old-tree build before
// the module body finishes evaluating, so a table sited further down is still in its
// temporal dead zone when the first run needs it.
const SITES = [
    {
        label: 'the require of the activation module',
        restores: false,
        head: "const ledgerPrecision = require('./ledger_amount_precision_activation');\n",
        legacy: '',
    },
    {
        label: 'getTokenSupply: the shared exact SUM expression',
        restores: false,
        head: "        let sumExpr = ledgerPrecision.exactSumSql('m.amount');\n",
        legacy: '',
    },
    {
        label: 'getTokenSupply: the credits sum casts to the tick scale',
        restores: true,
        head: '` + sumExpr + ` as credits',
        legacy: 'SUM(CAST(m.amount AS DECIMAL(60,` + decimals + `))) as credits',
    },
    {
        label: 'getTokenSupply: the debits sum casts to the tick scale',
        restores: true,
        head: '` + sumExpr + ` as debits',
        legacy: 'SUM(CAST(m.amount AS DECIMAL(60,` + decimals + `))) as debits',
    },
    {
        label: 'getTokenSupply: the escrows sum casts to the tick scale',
        restores: true,
        head: '` + sumExpr + ` as escrows',
        legacy: 'SUM(CAST(m.amount AS DECIMAL(60,` + decimals + `))) as escrows',
    },
    {
        label: 'getTokenSupply: the supply is netted at the tick scale',
        restores: true,
        head: '        let exact = ledgerPrecision.LEDGER_AMOUNT_PRECISION;\n' +
              '        supply = this.util.bcadd(this.util.bcsub(credits, debits, exact), escrows, decimals);',
        legacy: '        supply = this.util.bcadd(this.util.bcsub(credits, debits, decimals), escrows, decimals);',
    },
    {
        label: 'getHolders: the tick precision lookup comes back',
        restores: true,
        head: "        let holderSumExpr = ledgerPrecision.exactSumSql('m.amount');\n" +
              '        let exact         = ledgerPrecision.LEDGER_AMOUNT_PRECISION;\n',
        legacy: '        let decimals = await this.getTokenDecimalPrecision(tick_id);\n',
    },
    {
        label: 'getHolders: the credits sum casts to the tick scale',
        restores: true,
        head: '` + holderSumExpr + ` as credits,',
        legacy: 'SUM(CAST(m.amount AS DECIMAL(60,` + decimals + `))) as credits,',
    },
    {
        label: 'getHolders: the debits sum casts to the tick scale',
        restores: true,
        head: '` + holderSumExpr + ` as debits,',
        legacy: 'SUM(CAST(m.amount AS DECIMAL(60,` + decimals + `))) as debits,',
    },
    {
        label: 'getHolders: a holding is netted at the tick scale',
        restores: true,
        head: '                let balance = this.util.bcsub(holders[row.address], row.debits, exact);',
        legacy: '                let balance = this.util.bcsub(holders[row.address], row.debits, decimals);',
    },
    {
        label: 'createLedgerChangeRecord: the WRITE-side quantization scale',
        restores: true,
        head: '        let decimals = ledgerPrecision.ledgerWriteScale(\n' +
              '            await this.getTokenDecimalPrecision(tick_id),\n' +
              "            this.blockIndex, this.config['NETWORK'], this.config['COIN']);",
        legacy: '        let decimals = await this.getTokenDecimalPrecision(tick_id);',
    },
    {
        label: 'getAddressCreditDebit: the running total rounds per row',
        restores: true,
        head: '                    data[row.tick_id] = this.util.bcadd(\n' +
              '                        data[row.tick_id], row.amount, ledgerPrecision.LEDGER_AMOUNT_PRECISION);',
        legacy: '                    data[row.tick_id] = this.util.bcadd(data[row.tick_id], row.amount, row.decimals);',
    },
    {
        label: 'sanityCheck: tick ids are grouped by decimal scale again',
        restores: true,
        head: '        let idToTick = {};\n' +
              '        let allIds   = [];\n' +
              '        for(let tick of tickList){\n' +
              '            let id = tickers[tick];\n' +
              '            idToTick[id] = tick;\n' +
              '            allIds.push(id);\n' +
              '        }',
        legacy: '        let idToTick     = {};\n' +
                '        let idsByDecimals = {};\n' +
                '        let allIds        = [];\n' +
                '        for(let tick of tickList){\n' +
                '            let id = tickers[tick];\n' +
                '            let d  = decimals[tick];\n' +
                '            idToTick[id] = tick;\n' +
                '            (idsByDecimals[d] = idsByDecimals[d] || []).push(id);\n' +
                '            allIds.push(id);\n' +
                '        }',
    },
    {
        label: 'sanityCheck: one grouped SUM per distinct decimal scale',
        restores: true,
        head: '        let sumByTick = async (table, joinActions) => {\n' +
              '            let out          = {};\n' +
              "            let placeholders = allIds.map(() => '?').join(', ');\n" +
              '            let from         = joinActions\n' +
              "                ? table + ' m INNER JOIN actions a ON (a.action_index=m.action_index)'\n" +
              "                : table + ' m';\n" +
              "            let q = 'SELECT m.tick_id AS tick_id, ' + ledgerPrecision.exactSumSql('m.amount') + ' AS s'\n" +
              "                  + ' FROM ' + from + ' WHERE m.tick_id IN (' + placeholders + ') GROUP BY m.tick_id';\n" +
              '            let rows = await this.doQuery(q, allIds);\n' +
              '            for(let row of rows){\n' +
              '                if(!this.util.isNull(row.s)) out[Number(row.tick_id)] = row.s;\n' +
              '            }\n' +
              '            return out;\n' +
              '        };',
        legacy: '        let sumByTick = async (table, joinActions) => {\n' +
                '            let out = {};\n' +
                '            for(let d in idsByDecimals){\n' +
                '                let ids          = idsByDecimals[d];\n' +
                '                let dec          = parseInt(d, 10);\n' +
                "                let placeholders = ids.map(() => '?').join(', ');\n" +
                '                let from         = joinActions\n' +
                "                    ? table + ' m INNER JOIN actions a ON (a.action_index=m.action_index)'\n" +
                "                    : table + ' m';\n" +
                "                let q = 'SELECT m.tick_id AS tick_id, SUM(CAST(m.amount AS DECIMAL(60,' + dec + '))) AS s'\n" +
                "                      + ' FROM ' + from + ' WHERE m.tick_id IN (' + placeholders + ') GROUP BY m.tick_id';\n" +
                '                let rows = await this.doQuery(q, ids);\n' +
                '                for(let row of rows){\n' +
                '                    if(!this.util.isNull(row.s)) out[Number(row.tick_id)] = row.s;\n' +
                '                }\n' +
                '            }\n' +
                '            return out;\n' +
                '        };',
    },
    {
        label: 'sanityCheck: the ledger projection is netted at the tick scale',
        restores: true,
        head: '            let ledger  = this.util.bcnum(this.util.bcadd(\n' +
              '                this.util.bcsub(credits, debitsV, ledgerPrecision.LEDGER_AMOUNT_PRECISION), escLdg, d));',
        legacy: '            let ledger  = this.util.bcnum(this.util.bcadd(this.util.bcsub(credits, debitsV, d), escLdg, d));',
    },
];

// Declared before main() so a FAILING check on the synchronous prefix can still print
// its verdict instead of dying in the temporal dead zone.
let failures = 0;

if (process.argv.includes('--side')) {
    runSide().catch(e => { console.error('SIDE ERROR: ' + (e && e.stack || e)); process.exit(1); });
} else {
    main().catch(e => { console.error('ERR ' + (e && e.stack || e)); process.exit(1); });
}

// ---------------------------------------------------------------------------
// CHILD MODE: index the shared decoder corpus with ONE side's code.
// ---------------------------------------------------------------------------

async function runSide() {
    const root  = process.env.LAP_SIDE_ROOT;   // repo root this side runs from
    const mode  = process.env.LAP_SIDE_GATE;   // 'legacy' | 'off' | 'on'
    const first = parseInt(process.env.LAP_FIRST_BLOCK, 10);
    const last  = parseInt(process.env.LAP_LAST_BLOCK, 10);
    const coin  = process.env.INDEXER_COIN;
    const net   = process.env.INDEXER_NETWORK;

    let gateReport;
    if (mode === 'legacy') {
        // The old side has no flag to move. Report the ABSENCE as data, so the parent
        // asserts on what this process actually ran rather than on what it arranged.
        gateReport = { mode, modulePresent: fs.existsSync(path.join(root, FLAG_REL)) };
    } else {
        // Move the registered heights instead of stubbing the predicate: below the flag
        // it answers false BECAUSE the height has not been reached, and that is the code
        // path a pre-flag block takes. Mutated on the exported map before the launcher
        // pulls in db.js, and db.js holds a reference to this same object.
        const flag = require(path.join(root, FLAG_REL));
        const map  = flag.LEDGER_AMOUNT_PRECISION_ACTIVATION;
        for (const key of Object.keys(map)) map[key] = (mode === 'off') ? UNARMED : 0;
        gateReport = {
            mode, modulePresent: true,
            map: JSON.parse(JSON.stringify(map)),
            activeFirst: flag.isLedgerAmountPrecisionActive(first, net, coin),
            activeLast:  flag.isLedgerAmountPrecisionActive(last,  net, coin),
        };
    }

    const launcher = require(path.join(root, 'test', 'integration', 'setup', 'indexer-launcher.js'));
    const indexer  = await launcher.initIndexer();

    const t0 = Date.now();
    const blocks = await launcher.processBlocks(indexer);
    const ms = Date.now() - t0;
    await launcher.destroyIndexer(indexer);

    console.log(SIDE_MARK + JSON.stringify({ blocks, ms, gate: gateReport }));
    process.exit(0);
}

// ---------------------------------------------------------------------------
// PARENT
// ---------------------------------------------------------------------------

function check(ok, label, detail) {
    console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (detail ? '\n          ' + detail : ''));
    if (!ok) failures++;
    return ok;
}
function info(msg) { console.log('  ....  ' + msg); }
function section(title) { console.log('\n== ' + title + ' ' + '='.repeat(Math.max(0, 68 - title.length))); }

function parseArgs() {
    const a = process.argv.slice(2);
    const o = { preRef: '92cc8bb4^', keep: false, dryRun: false, corpus: 'synthetic',
                coin: 'BTC', network: 'regtest', gasTick: 'XCHAIN', decoderDb: null };
    for (let i = 0; i < a.length; i++) {
        switch (a[i]) {
            case '--pre-ref':    o.preRef = a[++i]; break;
            case '--corpus':     o.corpus = a[++i]; break;
            case '--decoder-db': o.decoderDb = a[++i]; o.corpus = 'real'; break;
            case '--coin':       o.coin = a[++i]; break;
            case '--network':    o.network = a[++i]; break;
            case '--gas-tick':   o.gasTick = a[++i]; break;
            case '--keep':       o.keep = true; break;
            case '--dry-run':    o.dryRun = true; break;
            case '--workdir':    o.workdir = a[++i]; break;
            case '--help': case '-h':
                console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
                process.exit(0);
                break;
            default: console.error('unknown arg: ' + a[i]); process.exit(64);
        }
    }
    if (o.corpus !== 'synthetic' && o.corpus !== 'real') {
        console.error('--corpus must be synthetic or real'); process.exit(64);
    }
    if (o.corpus === 'real' && !o.decoderDb) {
        console.error('--corpus real needs --decoder-db <existing schema>'); process.exit(64);
    }
    return o;
}

// --- the old side -----------------------------------------------------------

function occurrences(haystack, needle) {
    if (needle === '') return 0;
    return haystack.split(needle).length - 1;
}

// Whole-line comments dropped, so the completeness check below judges what the file
// EXECUTES. The rollback table deliberately leaves comment prose alone: a comment that
// still names the flag is stale wording, not a live call site, and treating the two the
// same would make a documentation sweep able to fail this tool.
function codeOnly(src) {
    return src.split('\n')
        .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
}

// Rewrite HEAD's src/db.js back to the pre-flag expressions. Returns the new source
// plus a per-site report, so the caller can assert on each substitution rather than
// on the fact that the function ran.
function rollBackLedgerPrecision(headSrc, preflagSrc) {
    let out = headSrc;
    const report = [];
    for (const site of SITES) {
        const inHead    = occurrences(headSrc, site.head);
        const inPreflag = site.restores ? occurrences(preflagSrc, site.legacy)
                                        : occurrences(preflagSrc, site.head);
        const ok = inHead === 1 && (site.restores ? inPreflag >= 1 : inPreflag === 0);
        if (ok) out = out.replace(site.head, site.legacy);
        report.push({ label: site.label, inHead, inPreflag, restores: site.restores, ok });
    }
    return { source: out, report };
}

// Materialize HEAD with `git archive` (a pure read of the object store), then roll the
// ledger-precision work out of src/db.js and delete the activation module, so a site
// the table missed cannot resolve at require time.
function materializeOldTree(preRef, dir) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    execSync('git archive HEAD | tar -x -C ' + JSON.stringify(dir), { cwd: REPO });
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));

    const headSrc = fs.readFileSync(path.join(dir, 'src', 'db.js'), 'utf8');
    const preflagSrc = execSync('git show ' + JSON.stringify(preRef + ':src/db.js'),
        { cwd: REPO, maxBuffer: 1024 * 1024 * 64 }).toString();
    const rolled = rollBackLedgerPrecision(headSrc, preflagSrc);
    fs.writeFileSync(path.join(dir, 'src', 'db.js'), rolled.source);
    fs.rmSync(path.join(dir, FLAG_REL), { force: true });
    return { root: dir, report: rolled.report, source: rolled.source };
}

function sha256File(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// --- synthetic corpus -------------------------------------------------------
//
// Real base58check regtest P2PKH addresses, shared with the integration tier:
// utility.isCryptoAddress decodes and version-checks, so an invented string is
// rejected wherever an address is validated.
const A1 = 'mq7tVfobimRUPxPNnyd5mKn11SVmTiLxtu';   // issuer, funded with gas
const A2 = 'n4nbVcRRR5sEHyp2VYuLUvCyDmQmBoonoK';   // counterparty, funded with gas
const GAS_FUNDER = 'mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ';  // the canonical regtest gas address

const T0    = 1700000000;
const STEP  = 60;
const GAS_B = 99;        // gas preamble block (first block - 1, kept contiguous)
const TOK   = 'PARENT';  // the 8-decimal control tick
const CHILDREN = 10;     // subtoken issuances in the batch shape

// S1. The gas tick is issued with ZERO decimals, which is what a regtest chain
// actually carries and the only reason a fee computed at 8 decimal places can land
// off its own tick's grid. An 8-decimal gas tick cannot fork under this rule at all.
const GAS_DECIMALS = 0;

// Block index -> the shape it carries, so witnesses address shapes by block rather
// than by position in a list a corpus edit could renumber.
const SHAPE_BLOCK = { S1: 99, C1: 100, C1b: 101, S2: 102, S3: 103, C2: 104, C2b: 105 };
const FIRST_BLOCK = 99;
const LAST_BLOCK  = 105;

function batchOf(commands) { return 'BATCH|0|' + commands.join(';'); }

function corpus(gasTick) {
    const t = n => T0 + (n - 100) * STEP;
    const blocks = [];

    // 99: S1, the gas preamble. Explicit tx hashes in a 'b'-prefixed space, the same
    // convention the shared gas seeder uses, so they cannot collide with the seeder's
    // auto-generated 'a'-prefixed hashes.
    blocks.push({ block: SHAPE_BLOCK.S1, time: t(99), txs: [
        { source: GAS_FUNDER, txHash: 'b'.repeat(56) + '00000001',
          data: `ISSUE|0|${gasTick}|21000000|100000|${GAS_DECIMALS}|Gas bootstrap` },
        { source: A1, txHash: 'b'.repeat(56) + '00000002', data: `MINT|0|${gasTick}|100000` },
        { source: A2, txHash: 'b'.repeat(56) + '00000003', data: `MINT|0|${gasTick}|100000` },
    ] });

    // 100/101: C1, an ordinary token at 8 decimals, and its supply. A plain issuance
    // is priced at a whole number of gas-price units, so its fee row sits on the gas
    // tick's grid and must be written identically by both rules.
    blocks.push({ block: SHAPE_BLOCK.C1, time: t(100), txs: [
        { source: A1, data: `ISSUE|0|${TOK}|1000000|100000|8|precision corpus` },
    ] });
    blocks.push({ block: SHAPE_BLOCK.C1b, time: t(101), txs: [
        { source: A1, data: `MINT|0|${TOK}|100000` },
    ] });

    // 102: S2, the headline. A subtoken issuance is priced at half a gas-price unit,
    // so the legacy rule rounds the DEBIT up to a whole unit while `fees` keeps the
    // true half. This is the single row the whole flag-day exists for.
    blocks.push({ block: SHAPE_BLOCK.S2, time: t(102), txs: [
        { source: A1, data: `ISSUE|0|${TOK}.1|1000|100|8|child 1` },
    ] });

    // 103: S3, the same error multiplied. Every sub-command of a batch is metered
    // against the payer's balance as of its own action index, so the rounded rows
    // compound rather than cancelling.
    {
        const cmds = [];
        for (let i = 2; i <= CHILDREN + 1; i++) cmds.push(`ISSUE|0|${TOK}.${i}|1000|100|8|child ${i}`);
        blocks.push({ block: SHAPE_BLOCK.S3, time: t(103), txs: [
            { source: A1, data: batchOf(cmds) },
        ] });
    }

    // 104/105: C2, transfers of the 8-decimal tick, one coarse and one at its finest
    // representable unit. Both sit exactly on the tick's grid, so the exact rule and
    // the legacy rule store the SAME string and these rows must not move.
    blocks.push({ block: SHAPE_BLOCK.C2, time: t(104), txs: [
        { source: A1, data: `SEND|0|${TOK}|1.5|${A2}` },
    ] });
    blocks.push({ block: SHAPE_BLOCK.C2b, time: t(105), txs: [
        { source: A1, data: `SEND|0|${TOK}|0.00000001|${A2}` },
    ] });

    return blocks;
}

// --- db ---------------------------------------------------------------------

function dbParams() {
    const envVars = {};
    const envPath = path.join(REPO, '.env');
    if (fs.existsSync(envPath))
        for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
            const m = line.match(/^\s*([\w]+)\s*=\s*(.*)$/);
            if (m) envVars[m[1]] = m[2].trim();
        }
    return {
        host: process.env.TEST_DB_HOST || envVars.INDEXER_DB_HOST || '127.0.0.1',
        port: parseInt(process.env.TEST_DB_PORT || envVars.INDEXER_DB_PORT || '3306'),
        user: process.env.TEST_DB_USER || envVars.INDEXER_DB_USER || 'root',
        pass: process.env.TEST_DB_PASS || envVars.INDEXER_DB_PASS || '',
    };
}

async function connect(p, database) {
    const mariadb = require('mariadb');
    return mariadb.createConnection({
        host: p.host, port: p.port, user: p.user, password: p.pass,
        database, insertIdAsNumber: true, multipleStatements: true, connectTimeout: 10000,
    });
}

function queryFnFor(conn) { return (sql, args) => conn.query(sql, args); }

// --- comparison -------------------------------------------------------------

// Table-level diff over the SAME canonical snapshots assertCapturedStatesEqual
// consumes, so a difference this reports is a difference that comparator fails on.
function diffStates(stateA, stateB) {
    const tables = Array.from(new Set(Object.keys(stateA).concat(Object.keys(stateB)))).sort();
    const out = [];
    for (const t of tables) {
        const a = stateA[t] || [], b = stateB[t] || [];
        if (a.length === b.length && a.every((r, i) => r === b[i])) continue;
        const setA = new Set(a), setB = new Set(b);
        out.push({ table: t, aRows: a.length, bRows: b.length,
                   onlyA: a.filter(r => !setB.has(r)).length,
                   onlyB: b.filter(r => !setA.has(r)).length });
    }
    return out;
}

// The first block where two hash chains part, and on which field. assertHashChainsEqual
// throws the same fact; this returns it as data so the run can print the fork point
// beside the row-level delta rather than only inside an exception message.
function firstDivergence(chainA, chainB) {
    const len = Math.min(chainA.length, chainB.length);
    for (let i = 0; i < len; i++)
        for (const f of ['ledger', 'actions', 'contracts', 'state'])
            if (chainA[i][f] !== chainB[i][f])
                return { block: chainA[i].block_index, field: f,
                         a: String(chainA[i][f]).slice(0, 16), b: String(chainB[i][f]).slice(0, 16) };
    if (chainA.length !== chainB.length)
        return { block: null, field: 'length', a: chainA.length, b: chainB.length };
    return null;
}

// --- witnesses --------------------------------------------------------------

// Decimal strings arrive from several code paths with different trailing-zero shapes
// ('1.5' and '1.50000000' are the same ledger amount). Compare on the trimmed form so
// a formatting difference is never reported as a consensus difference, and vice versa.
function norm(v) {
    if (v === null || v === undefined) return null;
    let s = String(v).trim();
    if (!s.includes('.')) return s;
    s = s.replace(/0+$/, '');
    if (s.endsWith('.')) s = s.slice(0, -1);
    return s === '' ? '0' : s;
}

async function tickerId(q, tick) {
    const rows = await q('SELECT id FROM index_tickers WHERE tick = ?', [tick]);
    return rows.length ? Number(rows[0].id) : null;
}

async function tickDecimals(q, tick) {
    const rows = await q(
        'SELECT t.decimals FROM tokens t JOIN index_tickers k ON k.id = t.tick_id WHERE k.tick = ?', [tick]);
    return rows.length ? Number(rows[0].decimals) : null;
}

// The heart of the witness: for every fee-bearing action, the fee the action was
// CHARGED beside the gas-tick debit row that was actually WRITTEN for it. Under the
// legacy rule those two disagree wherever the fee is finer than the gas tick; under
// the exact rule they agree everywhere. Nothing else in the schema states the defect
// this directly.
async function feeRows(q, gasTickId) {
    if (gasTickId === null) return [];
    const rows = await q(
        'SELECT a.block_index AS block, f.action_index AS action_index, ' +
        '       f.xchain_amount AS charged, f.fee_version AS fee_version, ' +
        '       d.amount AS written ' +
        'FROM fees f ' +
        'JOIN actions a ON a.action_index = f.action_index ' +
        'LEFT JOIN debits d ON d.action_index = f.action_index AND d.tick_id = ? ' +
        'ORDER BY f.action_index', [gasTickId]);
    return rows.map(r => ({
        block: Number(r.block),
        action: String(r.action_index),
        charged: norm(r.charged),
        written: norm(r.written),
        feeVersion: Number(r.fee_version),
    }));
}

// Fee rows where the written debit does not equal the fee charged. A row with no gas
// debit at all is not a mismatch: several fee shapes are paid on the native lane and
// write nothing to the gas ledger.
function feeMismatches(rows) {
    return rows.filter(r => r.written !== null && r.written !== r.charged);
}

// Every ledger row for ONE tick, keyed so two sides can be compared without depending
// on surrogate ids. Used for the targeted control: an on-grid tick's rows must be
// identical no matter which rule wrote them.
async function ledgerRowsForTick(q, table, tick) {
    const rows = await q(
        'SELECT a.block_index AS block, m.action_index AS action_index, ' +
        '       ia.address AS address, m.amount AS amount ' +
        'FROM `' + table + '` m ' +
        'JOIN actions a ON a.action_index = m.action_index ' +
        'JOIN index_tickers t ON t.id = m.tick_id ' +
        'JOIN index_addresses ia ON ia.id = m.address_id ' +
        'WHERE t.tick = ? ORDER BY m.action_index, ia.address', [tick]);
    return rows.map(r => Number(r.block) + '|' + String(r.action_index) + '|' +
                         String(r.address) + '|' + norm(r.amount));
}

// Total gas-tick debits, summed at the exact scale so the sum itself cannot round the
// difference away. This is the number that says how much the corpus was overcharged.
async function gasDebitTotal(q, gasTickId) {
    if (gasTickId === null) return null;
    const rows = await q(
        'SELECT SUM(CAST(amount AS DECIMAL(60,18))) AS s FROM debits WHERE tick_id = ?', [gasTickId]);
    return rows.length && rows[0].s !== null ? norm(rows[0].s) : '0';
}

async function countRows(q, table) {
    const rows = await q('SELECT COUNT(*) AS n FROM `' + table + '`');
    return Number(rows[0].n);
}

async function witnesses(q, opts) {
    const gasId = await tickerId(q, opts.gasTick);
    const fees  = await feeRows(q, gasId);
    return {
        gasTickId: gasId,
        gasDecimals: await tickDecimals(q, opts.gasTick),
        gasDebited: await gasDebitTotal(q, gasId),
        fees,
        mismatches: feeMismatches(fees),
        feeAtBlock: (b) => fees.filter(r => r.block === b),
        counts: {
            actions: await countRows(q, 'actions'),
            fees:    await countRows(q, 'fees'),
            credits: await countRows(q, 'credits'),
            debits:  await countRows(q, 'debits'),
            escrows: await countRows(q, 'escrows'),
            balances: await countRows(q, 'balances'),
        },
    };
}

// --- main -------------------------------------------------------------------

async function main() {
    const opts = parseArgs();
    const p    = dbParams();
    const NS   = process.env.TEST_DB_NS || 'xchain_test_lap';
    const DB   = { OLD: NS + '_old', OFF: NS + '_off', ON: NS + '_on' };
    const DEC  = opts.corpus === 'real' ? opts.decoderDb : NS + '_dec';

    console.log('# below-the-flag replay equivalence for ' + GATE);
    console.log('# pre-ref: ' + opts.preRef + '   HEAD: ' +
        execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim());
    console.log('# corpus: ' + opts.corpus + '   decoder schema: ' + DEC +
        '   chain: ' + opts.coin + '/' + opts.network + '   gas tick: ' + opts.gasTick);
    if (!opts.dryRun)
        console.log('# db: ' + p.user + '@' + p.host + ':' + p.port + '  schemas ' +
            Object.values(DB).join(', '));

    // ---- N4: the old side is exactly this change, removed -------------------
    section('N4 the old side differs from HEAD by exactly this change');
    const readers = execSync(
        'git grep -l ' + JSON.stringify(FLAG_NAME) + ' HEAD -- src/ || true', { cwd: REPO })
        .toString().trim().split('\n').filter(Boolean)
        .map(l => l.replace(/^HEAD:/, '')).sort();
    check(readers.join(',') === 'src/db.js',
        'src/db.js is the only reader of the activation module',
        readers.length ? JSON.stringify(readers) : 'no reader found at all, which means the rollback table is stale');
    if (failures) { console.log('\nFAILED: the old side would not isolate this change'); process.exit(1); }

    const workdir = opts.workdir || path.join(os.tmpdir(), 'xchain-lap-oldtree');
    let old;
    try { old = materializeOldTree(opts.preRef, workdir); }
    catch (e) { console.error('cannot materialize the old tree: ' + e.message); process.exit(2); }
    info('old tree at ' + old.root);

    for (const r of old.report)
        check(r.ok, 'rolled back: ' + r.label,
            r.ok ? '' : (r.inHead !== 1
                ? 'the HEAD text occurs ' + r.inHead + ' times in src/db.js (expected exactly 1)'
                : (r.restores
                    ? 'the legacy text is not present in ' + opts.preRef + ':src/db.js'
                    : 'the HEAD text is ALREADY present in ' + opts.preRef +
                      ':src/db.js, so --pre-ref is at or after this work')));

    // Completeness, not just correctness: one missed site would leave the old side
    // running the new rule for that projection and the comparison would be a lie.
    const code     = codeOnly(old.source);
    const residual = occurrences(code, 'ledgerPrecision') + occurrences(code, FLAG_NAME);
    check(residual === 0, 'the rolled-back src/db.js executes no reference to the activation module',
        residual === 0 ? '' : residual + ' residual reference(s) outside comments; the rollback table has a gap');
    const inProse = occurrences(old.source, FLAG_NAME) - occurrences(code, FLAG_NAME);
    if (inProse > 0)
        info(inProse + ' comment mention(s) of the module survive in the old tree, which is ' +
             'stale prose and changes nothing the file executes');
    check(!fs.existsSync(path.join(old.root, FLAG_REL)),
        'the activation module is absent from the old tree, so a missed site cannot resolve');

    const parsed = spawnSync(process.execPath, ['--check', path.join(old.root, 'src', 'db.js')],
        { encoding: 'utf8' });
    check(parsed.status === 0, 'the rolled-back src/db.js still parses',
        parsed.status === 0 ? '' : String(parsed.stderr || '').split('\n').slice(0, 5).join(' '));

    // The harness is identical by construction (the old tree IS HEAD's archive), but a
    // future edit to materializeOldTree could break that quietly, so it is asserted.
    for (const rel of ['test/integration/setup/indexer-launcher.js',
                       'test/integration/setup/db-connection.js',
                       'test/integration/setup/equivalence.js',
                       'test/integration/setup/decoder-seeder.js',
                       'package.json']) {
        const a = path.join(REPO, rel), b = path.join(old.root, rel);
        const same = fs.existsSync(b) && sha256File(a) === sha256File(b);
        check(same, 'identical in both trees: ' + rel, same ? '' : 'the two sides would run different harnesses');
    }
    if (failures) { console.log('\nFAILED: old-tree construction'); process.exit(1); }

    if (opts.dryRun) {
        info('kept for inspection: ' + old.root);
        console.log('\nDRY RUN: the old side is constructible and self-consistent. ' +
            'No replay was driven, so this is NOT equivalence evidence.');
        process.exit(0);
    }

    // ---- databases and corpus ---------------------------------------------
    section('corpus');
    const admin = await connect(p, undefined);
    for (const name of Object.values(DB)) {
        await admin.query('DROP DATABASE IF EXISTS `' + name + '`');
        await admin.query('CREATE DATABASE `' + name + '`');
    }
    if (opts.corpus === 'synthetic') {
        await admin.query('DROP DATABASE IF EXISTS `' + DEC + '`');
        await admin.query('CREATE DATABASE `' + DEC + '`');
    }
    await admin.end();

    process.env.TEST_DB_HOST = p.host;
    process.env.TEST_DB_PORT = String(p.port);
    process.env.TEST_DB_USER = p.user;
    process.env.TEST_DB_PASS = p.pass;
    process.env.TEST_DECODER_DB = DEC;
    process.env.INDEXER_COIN    = opts.coin;
    process.env.INDEXER_NETWORK = opts.network;

    let firstBlock = FIRST_BLOCK, lastBlock = LAST_BLOCK, corpusBlocks = 0;
    let dbc = null;
    if (opts.corpus === 'synthetic') {
        dbc          = require(path.join(REPO, 'test/integration/setup/db-connection.js'));
        const Seeder = require(path.join(REPO, 'test/integration/setup/decoder-seeder.js'));
        await dbc.createDecoderSchema();
        const seeder = new Seeder(dbc.decoderQuery);
        const blocks = corpus(opts.gasTick);
        for (const b of blocks) await seeder.seedBlock(b.block, b.time, b.txs);
        corpusBlocks = blocks.length;
        info('seeded ' + corpusBlocks + ' decoder blocks (' + FIRST_BLOCK + '..' + LAST_BLOCK + '), ' +
             blocks.reduce((n, b) => n + b.txs.length, 0) + ' transactions; gas tick ' +
             opts.gasTick + ' issued with ' + GAS_DECIMALS + ' decimals');
    } else {
        const dec = await connect(p, DEC);
        const rows = await dec.query('SELECT MIN(block_index) lo, MAX(block_index) hi, COUNT(*) n FROM blocks');
        const txs  = await dec.query('SELECT COUNT(*) n FROM transactions');
        firstBlock = Number(rows[0].lo);
        lastBlock  = Number(rows[0].hi);
        corpusBlocks = Number(rows[0].n);
        info('replaying existing decoder schema ' + DEC + ': blocks ' + firstBlock + '..' + lastBlock +
             ' (' + corpusBlocks + '), ' + txs[0].n + ' transactions');
        check(corpusBlocks > 0, 'the real corpus actually contains blocks',
            'an empty decoder schema cannot be quoted as evidence about anything');
        await dec.end();
        if (failures) { console.log('\nFAILED: corpus'); process.exit(2); }
    }

    // ---- run the three sides ----------------------------------------------
    section('sides');
    const sides = [
        { key: 'OLD', root: old.root, gate: 'legacy', db: DB.OLD, label: 'HEAD minus the exact-ledger work' },
        { key: 'OFF', root: REPO,     gate: 'off',    db: DB.OFF, label: 'HEAD, every height UNARMED' },
        { key: 'ON',  root: REPO,     gate: 'on',     db: DB.ON,  label: 'HEAD, every height forced to 0 (control)' },
    ];
    const reports = {};
    for (const s of sides) {
        const env = Object.assign({}, process.env, {
            LAP_SIDE_ROOT: s.root, LAP_SIDE_GATE: s.gate,
            LAP_FIRST_BLOCK: String(firstBlock), LAP_LAST_BLOCK: String(lastBlock),
            TEST_INDEXER_DB: s.db, TEST_DECODER_DB: DEC,
            INDEXER_COIN: opts.coin, INDEXER_NETWORK: opts.network,
        });
        const r = spawnSync(process.execPath, [__filename, '--side'],
            { env, encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 });
        const line = String(r.stdout || '').split('\n').find(l => l.startsWith(SIDE_MARK));
        if (r.status !== 0 || !line) {
            console.error('side ' + s.key + ' failed (exit ' + r.status + ')');
            console.error(String(r.stderr || '').split('\n').slice(-25).join('\n'));
            console.error(String(r.stdout || '').split('\n').slice(-15).join('\n'));
            process.exit(1);
        }
        reports[s.key] = JSON.parse(line.slice(SIDE_MARK.length));
        info(s.key.padEnd(3) + ' ' + s.label.padEnd(46) + reports[s.key].blocks + ' blocks in ' +
             (reports[s.key].ms / 1000).toFixed(1) + 's');
    }

    // ---- N1: the gate really was where we said it was ---------------------
    section('N1 gate state proven per side');
    check(reports.OLD.gate.modulePresent === false,
        'OLD ran a tree with no activation module in it at all',
        JSON.stringify(reports.OLD.gate));
    check(reports.OFF.gate.activeFirst === false && reports.OFF.gate.activeLast === false,
        'OFF: the rule is inactive at BOTH ends of the corpus (block ' + firstBlock +
        ' and block ' + lastBlock + ')',
        JSON.stringify(reports.OFF.gate));
    check(reports.ON.gate.activeFirst === true && reports.ON.gate.activeLast === true,
        'ON: the rule is active at both ends of the corpus',
        JSON.stringify(reports.ON.gate));
    check(reports.OLD.blocks === reports.OFF.blocks && reports.OFF.blocks === reports.ON.blocks,
        'all three sides processed the same block count',
        'OLD=' + reports.OLD.blocks + ' OFF=' + reports.OFF.blocks + ' ON=' + reports.ON.blocks);

    // ---- witnesses --------------------------------------------------------
    section('N3 witnesses: what each side wrote to the ledger');
    const conns = {};
    for (const k of ['OLD', 'OFF', 'ON']) conns[k] = await connect(p, DB[k]);
    const q = { OLD: queryFnFor(conns.OLD), OFF: queryFnFor(conns.OFF), ON: queryFnFor(conns.ON) };

    const wOld = await witnesses(q.OLD, opts);
    const wOff = await witnesses(q.OFF, opts);
    const wOn  = await witnesses(q.ON,  opts);
    info('OLD row counts: ' + JSON.stringify(wOld.counts));
    info('ON  row counts: ' + JSON.stringify(wOn.counts));
    info('gas tick ' + opts.gasTick + ' decimals: OLD=' + wOld.gasDecimals + ' ON=' + wOn.gasDecimals);
    info('gas debited in total: OLD=' + wOld.gasDebited + '  OFF=' + wOff.gasDebited +
         '  ON=' + wOn.gasDebited);
    info('fee rows: OLD=' + wOld.fees.length + ' (' + wOld.mismatches.length + ' rounded away from the fee charged)' +
         '  ON=' + wOn.fees.length + ' (' + wOn.mismatches.length + ')');

    check(wOld.gasTickId !== null,
        'the gas tick ' + opts.gasTick + ' exists in the replayed ledger',
        wOld.gasTickId !== null ? '' : 'nothing was denominated in the gas tick, so no fee row can be judged');
    check(wOld.fees.length > 0, 'the corpus produced fee-bearing actions',
        wOld.fees.length > 0 ? '' : 'with no fees there is no amount finer than its tick and nothing to measure');

    // The OLD side has to be exhibiting the DEFECT, or "identical" is satisfied by two
    // sides that both had nothing to round.
    check(wOld.mismatches.length > 0,
        'OLD writes a gas debit that DISAGREES with the fee charged (the legacy rounding is present)',
        wOld.mismatches.length > 0
            ? JSON.stringify(wOld.mismatches.slice(0, 6))
            : 'every fee in this corpus already sits on the gas tick grid (gas decimals ' +
              wOld.gasDecimals + '), so this corpus cannot see the rule at all');

    if (opts.corpus === 'synthetic') {
        const s2Old = wOld.feeAtBlock(SHAPE_BLOCK.S2);
        const s2On  = wOn.feeAtBlock(SHAPE_BLOCK.S2);
        check(s2Old.length === 1 && s2Old[0].charged === '0.5' && s2Old[0].written === '1',
            'S2 subtoken issuance: OLD charges half a unit and DEBITS a whole one',
            JSON.stringify(s2Old));
        check(s2On.length === 1 && s2On[0].charged === '0.5' && s2On[0].written === '0.5',
            'control: with the rule ON the same action debits exactly what it charged',
            JSON.stringify(s2On));
    }

    // ---- the equivalence assertion ----------------------------------------
    section('OLD vs HEAD-with-every-height-UNARMED');
    const eq = require(path.join(REPO, 'test/integration/setup/equivalence.js'));
    const stateOLD = await eq.captureDbState(q.OLD, { mode: 'strict' });
    const stateOFF = await eq.captureDbState(q.OFF, { mode: 'strict' });
    const stateON  = await eq.captureDbState(q.ON,  { mode: 'strict' });

    const chainOLD = await eq.readHashChain(q.OLD);
    const chainOFF = await eq.readHashChain(q.OFF);
    const chainON  = await eq.readHashChain(q.ON);

    let hashOk = true, hashErr = '';
    try { eq.assertHashChainsEqual(chainOLD, chainOFF, 'OLD', 'OFF'); }
    catch (e) { hashOk = false; hashErr = e.message; }
    check(hashOk, 'consensus hash chain identical at all ' + chainOLD.length +
        ' blocks (ledger/actions/contracts + state)',
        hashOk ? 'first block ' + chainOLD[0].block_index + ' ledger=' + String(chainOLD[0].ledger).slice(0, 16) + '...  ' +
                 'last block ' + chainOLD[chainOLD.length - 1].block_index + ' ledger=' +
                 String(chainOLD[chainOLD.length - 1].ledger).slice(0, 16) + '...'
               : hashErr);

    const dOffOld = diffStates(stateOLD, stateOFF);
    check(dOffOld.length === 0,
        'every table byte-identical OLD vs OFF (' + Object.keys(stateOLD).length + ' tables, strict mode)',
        dOffOld.length === 0
            ? 'row totals: ' + Object.values(stateOLD).reduce((n, r) => n + r.length, 0)
            : JSON.stringify(dOffOld, null, 2));

    // Stated separately from the table diff because it is the claim the flag module
    // makes in its own right: the UNGATED read-side change is a no-op on legacy rows.
    check(wOff.gasDebited === wOld.gasDebited &&
          JSON.stringify(wOff.fees) === JSON.stringify(wOld.fees),
        'the ungated read-side aggregation is a no-op: OFF projects what OLD projected',
        'OLD=' + wOld.gasDebited + ' OFF=' + wOff.gasDebited);

    // ---- N2: the harness can see a fork -----------------------------------
    section('N2 negative control: the SAME comparator against the rule forced ON');
    const dOnOld    = diffStates(stateOLD, stateON);
    const forkPoint = firstDivergence(chainOLD, chainON);

    check(dOnOld.length > 0, 'forcing the rule ON moves committed state (so the pass above is not vacuous)',
        dOnOld.length > 0
            ? dOnOld.length + ' tables differ: ' + dOnOld.map(d => d.table + '(' + d.aRows + '->' + d.bRows + ')').join(', ')
            : 'ON matched OLD: nothing in this corpus carries an amount finer than its own tick ' +
              '(gas tick decimals ' + wOn.gasDecimals + '), so the pass above proves NOTHING');
    check(forkPoint !== null, 'and it moves the CONSENSUS HASH CHAIN, not just local rows',
        forkPoint ? 'first divergence: block ' + forkPoint.block + ' ' + forkPoint.field +
                    ' OLD=' + forkPoint.a + '... ON=' + forkPoint.b + '...'
                  : 'the rule moved rows but not the hash chain, which would mean the comparison ' +
                    'above is weaker than it looks');

    // The write path is where this rule lives, so the control has to move the write
    // path's own tables. Balances and their commitment are what a fork actually costs.
    const movedTables = new Set(dOnOld.map(d => d.table));
    for (const t of ['debits', 'balances', 'blocks'])
        check(movedTables.has(t), 'control moves `' + t + '` (the surface this rule changes)',
            movedTables.has(t) ? '' : 'the corpus does not reach the gated write path for ' + t);

    check(wOn.mismatches.length === 0,
        'control is ATTRIBUTABLE: with the rule ON every gas debit equals the fee charged',
        wOn.mismatches.length === 0 ? '' : JSON.stringify(wOn.mismatches.slice(0, 6)));

    if (opts.corpus === 'synthetic') {
        // Targeted, not blanket. An 8-decimal tick moved in 8-decimal amounts is already
        // exact, so both rules store the same string and these rows must be untouched.
        // Without this the control would pass for a rule that simply rewrote every row.
        for (const table of ['credits', 'debits']) {
            const a = await ledgerRowsForTick(q.OLD, table, TOK);
            const b = await ledgerRowsForTick(q.ON,  table, TOK);
            check(a.length > 0 && JSON.stringify(a) === JSON.stringify(b),
                'control is TARGETED: `' + table + '` rows for the on-grid tick ' + TOK +
                ' are unchanged by the rule',
                a.length === 0 ? 'no rows for ' + TOK + ', so this control measured nothing'
                               : 'OLD=' + a.length + ' rows, ON=' + b.length + ' rows');
        }
        const c1Old = wOld.feeAtBlock(SHAPE_BLOCK.C1);
        const c1On  = wOn.feeAtBlock(SHAPE_BLOCK.C1);
        check(c1Old.length === 1 && c1On.length === 1 && c1Old[0].written === c1On[0].written,
            'control is TARGETED: C1 whole-unit issuance fee is debited identically on both sides',
            'OLD=' + JSON.stringify(c1Old) + ' ON=' + JSON.stringify(c1On));
    } else {
        info('real-corpus fee delta: OLD overcharged ' + wOld.mismatches.length +
             ' of ' + wOld.fees.length + ' fee-bearing actions relative to what it charged');
    }

    // ---- coverage statement ----------------------------------------------
    section('coverage of this run');
    if (opts.corpus === 'synthetic') {
        info('COVERED, driven on all three sides: the WRITE-side quantization scale for');
        info('  credits, debits and escrows, and the four read-side projections the replay');
        info('  reaches (token supply, per-holder balances, the per-address credit/debit');
        info('  rollup and the per-block supply sanity check), over a gas tick coarser than');
        info('  the fees denominated in it, plus on-grid controls that must not move.');
        info('NOT COVERED: any projection this corpus never calls, and any tick shape it does');
        info('  not contain. The row counts printed above are the whole of what was measured.');
    } else {
        info('COVERED: every action this chain actually produced, replayed from its first');
        info('  block by both code paths, including whatever tick precisions it carries.');
        info('NOT COVERED: whatever this chain does not contain. If its gas tick is as fine');
        info('  as the fee arithmetic, the rule cannot fork it and this run measures the');
        info('  equivalence half only; the negative control lives in the synthetic run.');
    }

    for (const k of ['OLD', 'OFF', 'ON']) { try { await conns[k].end(); } catch (e) {} }
    if (dbc) { try { await dbc.closeAll(); } catch (e) {} }

    if (!opts.keep) {
        const a2 = await connect(p, undefined);
        for (const name of Object.values(DB)) await a2.query('DROP DATABASE IF EXISTS `' + name + '`');
        if (opts.corpus === 'synthetic') await a2.query('DROP DATABASE IF EXISTS `' + DEC + '`');
        await a2.end();
        fs.rmSync(workdir, { recursive: true, force: true });
    } else {
        info('kept: schemas ' + Object.values(DB).join(', ') + ' and old tree ' + workdir);
    }

    console.log(failures ? '\nFAILED: ' + failures + ' assertion(s)'
                         : '\nALL ASSERTIONS HOLD (evidence for the surfaces listed above)');
    process.exit(failures ? 1 : 0);
}

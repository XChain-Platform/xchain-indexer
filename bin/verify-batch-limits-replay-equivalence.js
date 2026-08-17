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
 * A7: BELOW-THE-FLAG REPLAY EQUIVALENCE for BATCH_ISSUANCE_LIMITS.
 *
 * WHY THIS EXISTS. BATCH_ISSUANCE_LIMITS carries a loosening (the dotted-TICK
 * exemption) AND several tightenings (the 250-command cap, the batch-cumulative
 * fee/settlement ledger, the caret-dot TICK rejection, the ticker-intern gating,
 * the aggregate gas pre-check, and - since a319226 - a one-payment-one-fill tally
 * on the ORDINARY non-batch dispense path). If ANY of that leaks below the gate,
 * a from-genesis replay reaches verdicts the live fleet never wrote, in both
 * directions at once, and the ledger forks. Acceptance test A7 is the evidence
 * that nothing leaks. It is the last gate before the operator may arm the flag on
 * mainnet, so it may not be a code-reading argument: it has to be driven.
 *
 * ------------------------------------------------------------------------------
 * THE OPERATIONALIZATION, AND WHY IT IS NOT THE LITERAL WORDING
 *
 * A7 as written says "blocks before the flag instant replay byte-identical on a
 * pre-flag chain". There is no such chain to point at. On regtest and testnet the
 * flag is GENESIS-ACTIVE (protocol_changes.js registers 0/0 for both), so those
 * chains have no pre-flag region at all, and mainnet is UNARMED at the house
 * sentinel 9999999999, so its ENTIRE history is pre-flag and there is nothing to
 * diff a boundary against. Diffing across a height is therefore not available on
 * any chain that exists.
 *
 * What A7 actually has to establish is one property, and it can be stated without
 * a boundary: BELOW THE GATE, THE NEW CODE MUST COMMIT EXACTLY WHAT THE OLD CODE
 * COMMITTED. So this tool builds the comparison the boundary would have given:
 *
 *   side OLD  - the code as it stood at `2588135^`, the last commit before any of
 *               this work existed, extracted from git and run unmodified.
 *   side OFF  - the code at HEAD, with BATCH_ISSUANCE_LIMITS pinned to the UNARMED
 *               sentinel on every network, i.e. a block below the flag instant.
 *   side ON   - the code at HEAD with the flag as regtest actually ships it
 *               (genesis-active). This is the NEGATIVE CONTROL, not evidence.
 *
 * All three index the SAME decoder corpus from genesis into three separate
 * databases. OLD vs OFF must be byte-identical, table for table and hash for hash.
 * That is the same statement a height boundary would make, over strictly more
 * transactions than any real boundary block would contain.
 *
 * WHY THE GATE IS FORCED BY MOVING THE INSTANT AND NOT BY STUBBING isEnabled: the
 * pre-flag condition IS "the instant has not arrived". Rewriting the registered
 * activation times to the sentinel makes the REAL isEnabled evaluate the REAL gate
 * and answer false the same way it answers false on mainnet today. A stubbed
 * isEnabled would prove that a stub returns false.
 *
 * ------------------------------------------------------------------------------
 * WHY A PURPOSE-BUILT CORPUS AND NOT A RUNNING CHAIN
 *
 * A comparison over inert data proves nothing: if no transaction in the corpus is
 * one the change was designed to affect, the two sides agree trivially. So the
 * corpus is built out of exactly the adversarial shapes the acceptance run put on
 * the BTC regtest chain, plus the shapes the newly-widened dispense scope needs:
 *
 *   1. 1 undotted + 50 dotted ISSUEs in one BATCH   (A1: the headline loosening)
 *   2. a 251-command BATCH                          (A2: the cap)
 *   3. an exactly-250-command BATCH                 (A2: the cap NOT tripped)
 *   4. two undotted ISSUEs in one BATCH             (A2: the pre-existing limit)
 *   5. a lone caret-dot ISSUE  ^<id>.<n>            (A3)
 *   6. a dotted ISSUE with no parent                (R6: the free ticker intern)
 *   7. a single-ISSUE BATCH from a gasless source   (R4: the aggregate pre-check)
 *   8. TWO dispensers behind ONE paid address       (row 19: ordinary-path tally)
 *   9. a SEND that triggers a dispenser, overpaid   (row 18/20: get_amount)
 *  10. 3 ORDERs paying ONE ORDER's native-coin fee  (R5: the fee ledger)
 *  11. the same 3 ORDERs paying three ORDERs' worth (R5: N worth funds N)
 *  12. 3 Mode B DISPENSERs on ONE oracle fee output   (R5b: validateOracleFee)
 *  13. 2 Mode B DISPENSERs on TWO opens' worth        (R5b: the tally drains)
 *
 * Shapes 8 and 9 are ORDINARY, non-batch transactions: since a319226 the flag no
 * longer gates only BATCH behavior, so a comparison over batch shapes alone would
 * leave the newly-gated ordinary dispense path entirely unmeasured and pass anyway.
 * Shapes 10/11 run on the NATIVE fee lane in the same corpus: an output paying
 * FEE_DESTINATION is what flips detectFeePaymentMode, so one BTC regtest chain
 * exercises both the XCHAIN-balance lane and the native-coin lane.
 *
 * Shapes 12/13 reach validateOracleFee's PER-ORACLE tally, which every earlier run
 * of this tool named as the one gated site it did not touch. A Mode B DISPENSER
 * (ORACLE_ADDRESS set) owes the oracle operator a real native-coin output at open
 * time, so N opens referencing one oracle in one batch is the same
 * one-value-satisfies-N shape shapes 10/11 put on the native fee lane, against a
 * different pool. Shape 12's third sub-command names a SECOND oracle that is paid
 * nothing, so the run distinguishes the tally's verdict (`insufficient oracle fee`)
 * from a blanket rejection (`missing oracle fee output`) by error string.
 *
 * Each of those has a WITNESS assertion (below) pinning what the OLD side actually
 * did with it, so a corpus that silently stopped exercising the change cannot pass
 * by agreeing about nothing.
 *
 * ------------------------------------------------------------------------------
 * NEGATIVE CONTROLS (the house standard: a comparison that would pass even if the
 * gate did nothing is worthless)
 *
 *   N1. GATE STATE IS PROVEN, NOT ASSUMED. Each side reports the activation times
 *       its OWN ProtocolChanges instance registered. OLD must not know the flag at
 *       all (undefined - proof we really ran pre-flag code); OFF must read the
 *       sentinel; ON must read 0.
 *   N2. THE HARNESS DETECTS DIVERGENCE. Side ON is compared against OLD with the
 *       same comparator. It MUST differ, and it must differ in the tables the
 *       change is supposed to move. A run where ON matches OLD means the corpus
 *       stopped reaching the gated code and the OLD-vs-OFF pass is vacuous, so
 *       that is reported as a FAILURE of this tool, not a pass.
 *   N3. THE WITNESSES. Specific verdicts on the OLD side (e.g. the 51-ISSUE batch
 *       is `invalid: ISSUE (limit)`, two dispensers both fill off one payment) are
 *       asserted individually, so "identical" cannot be satisfied by two sides
 *       that both did nothing.
 *   N4. HARNESS PARITY. The launcher/db-connection/equivalence files are byte-
 *       compared between the two trees. If the harness itself moved between the
 *       old ref and HEAD, the diff would confound harness with product and the
 *       tool refuses to run.
 *
 * ------------------------------------------------------------------------------
 * WHAT IT DOES NOT COVER - read this before quoting a green run.
 *
 * ONE of R5's consumers is absent from the corpus, and it is not an oversight:
 *
 *   - COINPAY's settlement-value tally, which is STRUCTURALLY unreachable inside a
 *     BATCH today: the decoder gates payment-output capture on the raw data
 *     starting with `COINPAY|`, false for a `BATCH|...` transaction, so
 *     COIN_AMOUNT / COIN_DESTINATION never reach the indexer (spec row 21). There
 *     is no wire path to exercise, and manufacturing one here would test a shape
 *     the fleet cannot produce.
 *
 * And one property of a covered site is out of this harness's reach, stated so it
 * is not mistaken for coverage:
 *
 *   - `oracleFeeConsumed` is keyed BY ORACLE ADDRESS so one exhausted output cannot
 *     invalidate a sub-command paying a DIFFERENT oracle. Witnessing that positively
 *     needs one transaction carrying an adequate output for EACH of two oracles.
 *     That was IMPOSSIBLE here until spec row 49: indexer-launcher.js did not apply
 *     output_fanout.collapseOutputFanout the way XChainIndexer.start does, so a
 *     data-bearing transaction with two outputs executed once PER OUTPUT, a harness
 *     artifact rather than product behavior. The launcher now collapses like
 *     production and decoder-seeder.js can emit a full output set, so the positive
 *     witness is CONSTRUCTIBLE and simply is not built yet; do not read the wording
 *     below as a standing impossibility. Shape 12 still pins the weaker thing: the
 *     unpaid oracle's sub-command fails with the MISSING-output string on every
 *     side, while only the flag-ON side produces the tally's INSUFFICIENT string,
 *     so the two verdicts cannot be confused.
 *
 * PRICE v1 oracle rows are seeded directly into `oracle_prices`, not published as
 * PRICE v1 actions in the corpus, and that is the faithful shape rather than a
 * shortcut: `oracle_prices` is a HUB-MIRRORED table (src/sql/oracle_prices.sql,
 * populated by hub_db_sync). The indexer never writes it, so a PRICE v1 action in
 * the corpus would land in `prices` and leave the row validateOracleFee reads
 * absent. Same reason price_snapshots is seeded rather than mined.
 *
 * The summary at the end of every run restates this, so a green run cannot be
 * quoted as covering more than it does.
 *
 * READ-ONLY WITH RESPECT TO THE REPOSITORY. The old tree is materialized with
 * `git archive` (no worktree metadata, no index, no ref writes) into a temp dir.
 * The tool writes only to its own throwaway databases.
 *
 * USAGE
 *   node bin/verify-batch-limits-replay-equivalence.js
 *   node bin/verify-batch-limits-replay-equivalence.js --old-ref 2588135^ --keep
 *
 * Needs a MariaDB the test user may CREATE schemas on:
 *   TEST_DB_HOST TEST_DB_PORT TEST_DB_USER TEST_DB_PASS (fall back to .env
 *   INDEXER_DB_* exactly like test/integration/setup/db-connection.js), and
 *   TEST_DB_NS (default xchain_test_a7) for the throwaway schema prefix.
 *
 * EXIT: 0 every assertion holds, 1 an assertion failed, 2 cannot run.
 *
 *********************************************************************/

'use strict';

const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

const REPO       = path.resolve(__dirname, '..');
const GATE       = 'BATCH_ISSUANCE_LIMITS';
const UNARMED    = 9999999999;      // the house UNARMED sentinel (protocol_changes.js)
const SIDE_MARK  = '###A7-SIDE###'; // child -> parent report line

// ---------------------------------------------------------------------------
// CHILD MODE: index the shared decoder corpus with ONE side's code.
// ---------------------------------------------------------------------------
/* Declared BEFORE main() runs, not beside check() further down.
 *
 * main() is invoked synchronously below, and its prefix through the harness-parity
 * loop is synchronous too, so a `let` sited next to check() was still in its temporal
 * dead zone when the first FAILING check ran. The failure path therefore died with a
 * ReferenceError instead of printing its verdict and exiting 1. Passing checks never
 * touch the counter, which is exactly why this survived every green run: the only code
 * path that could reveal it was the one that had never been taken.
 */
let failures = 0;

if (process.argv.includes('--side')) {
    runSide().catch(e => { console.error('SIDE ERROR: ' + (e && e.stack || e)); process.exit(1); });
} else {
    main().catch(e => { console.error('ERR ' + (e && e.stack || e)); process.exit(1); });
}

async function runSide() {
    const root = process.env.A7_SIDE_ROOT;      // repo root this side runs from
    const gate = process.env.A7_SIDE_GATE;      // 'natural' | 'off'

    // Move the registered activation instant instead of stubbing the gate: below the
    // flag, isEnabled answers false BECAUSE the instant has not arrived, and that is
    // the code path a pre-flag block takes. Patched on the prototype before
    // initIndexer constructs the instance, and only for THIS flag - every sibling
    // gate keeps whatever the tree under test registers for it.
    if (gate === 'off') {
        const PC = require(path.join(root, 'src', 'protocol_changes.js'));
        const realAddChange = PC.prototype.addChange;
        PC.prototype.addChange = function (name, version, mt, tt, rt, mb, tb, rb) {
            if (name === GATE) { mt = tt = rt = UNARMED; mb = tb = rb = 0; }
            return realAddChange.call(this, name, version, mt, tt, rt, mb, tb, rb);
        };
    }

    // Each side runs its OWN tree's launcher, so the OLD side is driven by the
    // harness that shipped with it. Harness parity is proven separately (N4), which
    // is what lets the two runs be compared as a product difference.
    const launcher = require(path.join(root, 'test', 'integration', 'setup', 'indexer-launcher.js'));
    const indexer  = await launcher.initIndexer();

    // N1: report the gate exactly as THIS side's ProtocolChanges registered it.
    const change = indexer.protocolChanges.changes ? indexer.protocolChanges.changes[GATE] : undefined;
    const gateReport = change
        ? { registered: true, mainnet_time: Number(change.mainnet_time),
            testnet_time: Number(change.testnet_time), regtest_time: Number(change.regtest_time) }
        : { registered: false };

    // The native fee lane needs finalized oracle prices. Seeded here, after the side's
    // own verifyTables, so all three sides get byte-identical price_snapshots rows from
    // one code path rather than from three DB writes the parent has to keep in step.
    await seedPrices(indexer.indexerDb);

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
    const a = process.argv.slice(2), o = { oldRef: '2588135^', keep: false };
    for (let i = 0; i < a.length; i++) {
        switch (a[i]) {
            case '--old-ref': o.oldRef = a[++i]; break;
            case '--keep':    o.keep = true; break;
            case '--workdir': o.workdir = a[++i]; break;
            case '--help': case '-h':
                console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
                process.exit(0);
                break;
            default: console.error('unknown arg: ' + a[i]); process.exit(64);
        }
    }
    return o;
}

// --- corpus -----------------------------------------------------------------
//
// The addresses the integration tier already uses. They are REAL base58check testnet
// P2PKH addresses and have to be: utility.isCryptoAddress base58check-decodes and
// checks the version byte against the coin bundle, so an invented 34-character string
// is rejected wherever an address is validated (ORACLE_ADDRESS is one such field).
const A1 = 'mq7tVfobimRUPxPNnyd5mKn11SVmTiLxtu';   // issuer / dispenser owner, funded with gas
const A2 = 'n4nbVcRRR5sEHyp2VYuLUvCyDmQmBoonoK';   // counterparty, funded with gas
const A3 = 'mvuKWKvgzrkxh8QgNZ91vMBZUKN5BFYmo3';   // dispenser payment collector (TWO dispensers)
const A4 = 'mwGujTXFXMLN2YXqo4mQK4DcKy31DUcwoi';   // deliberately holds NO gas (R4 pre-check)
const A5 = 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef';   // second collector (get_amount attribution)
const ORACLE_A = 'mqmJDcs5nXFHrj9q7a2G5sBVmjcQTDdUZp';  // PRICE v1 oracle the paid output goes to
const ORACLE_B = 'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp';  // a SECOND oracle, deliberately never paid

const T0    = 1700000000;
const STEP  = 60;    // tight spacing: keeps every block inside one oracle price's staleness window
const GAS_B = 99;    // gas preamble block (seedGas convention: first block - 1)

const PARENT = 'PARENT';   // the parent tick the 50 children hang off
const DTOK   = 'DTOK';     // dispenser GIVE tick
const BETA   = 'BETA';     // dispenser GET tick

// Dispenser expiration, far enough out that processExpirations never closes one of
// these inside the corpus's ~17 minutes of block time.
const FAR = T0 + 86400 * 30;

// A Mode B (oracle-priced) DISPENSER open, the ONE shape that reaches
// utility.validateOracleFee. Mode B is what ORACLE_ADDRESS being set means: the oracle
// operator prices the token in FIAT_CODE and is paid a usage fee up front, so FIAT_CODE
// is required and FIAT_AMOUNT must stay empty (dispenser.js ~171-179).
// GET_ADDRESS is the SOURCE itself, which is always permitted (owner self-opening) and
// so keeps the third-party ADDRESS opt-in of shape 8 out of this shape entirely.
// DISPENSER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|
//            GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION|
//            ALLOW_LIST|BLOCK_LIST|MEMO
const MODE_B_ESCROW = '50';
function modeBDispenser(oracle) {
    return `DISPENSER|0|BTC|${DTOK}|1||${MODE_B_ESCROW}|BTC||0|${A1}|USD||${oracle}|${FAR}|||`;
}

function batchOf(commands) { return 'BATCH|0|' + commands.join(';'); }

function corpus() {
    const t = n => T0 + (n - 100) * STEP;
    const blocks = [];

    // 100: the three ticks. PARENT is the namespace the children need; DTOK/BETA
    // are the dispenser pair (token-for-token, so no native coin is involved).
    blocks.push({ block: 100, time: t(100), txs: [
        { source: A1, data: `ISSUE|0|${PARENT}|1000000|100000|0|batch parent` },
        { source: A1, data: `ISSUE|0|${DTOK}|1000000|100000|0|dispenser give` },
        { source: A2, data: `ISSUE|0|${BETA}|1000000|100000|0|dispenser get` },
    ] });

    // 101: supply.
    blocks.push({ block: 101, time: t(101), txs: [
        { source: A1, data: `MINT|0|${PARENT}|100000` },
        { source: A1, data: `MINT|0|${DTOK}|100000` },
        { source: A2, data: `MINT|0|${BETA}|100000` },
    ] });

    // 102: SHAPE 1 - one undotted parent plus 50 dotted children in ONE BATCH.
    // Below the flag all 51 count as ISSUE against actionLimits.ISSUE = 1, so the
    // whole batch is one invalid record. Above it, 50 are exempt and all 51 land.
    {
        const cmds = [`ISSUE|0|${PARENT}|1000000|100000|0|reissue parent`];
        for (let i = 1; i <= 50; i++) cmds.push(`ISSUE|0|${PARENT}.${i}|1000|100|0|child ${i}`);
        blocks.push({ block: 102, time: t(102), txs: [{ source: A1, data: batchOf(cmds) }] });
    }

    // 103: SHAPE 2 - 251 commands. Below the flag there is no cap and all 251 run;
    // above it the batch is one `invalid: COMMAND (limit)` record.
    {
        const cmds = [];
        for (let i = 0; i < 251; i++) cmds.push(`SEND|0|${PARENT}|1|${A2}`);
        blocks.push({ block: 103, time: t(103), txs: [{ source: A1, data: batchOf(cmds) }] });
    }

    // 104: SHAPE 3 - exactly 250 commands. The cap is NOT tripped, so this one must
    // behave identically on ALL THREE sides; it is what keeps the negative control
    // honest about being targeted rather than a blanket difference.
    {
        const cmds = [];
        for (let i = 0; i < 250; i++) cmds.push(`SEND|0|${PARENT}|1|${A2}`);
        blocks.push({ block: 104, time: t(104), txs: [{ source: A1, data: batchOf(cmds) }] });
    }

    // 105: SHAPE 4 - two undotted ISSUEs. The pre-existing per-action limit rejects
    // this above AND below the flag: another all-three-sides-agree control.
    blocks.push({ block: 105, time: t(105), txs: [{ source: A1, data: batchOf([
        'ISSUE|0|UNDOT1|1000|100|0|a', 'ISSUE|0|UNDOT2|1000|100|0|b',
    ]) }] });

    // 106: SHAPE 5 - the caret-dot escape. `^<id>.<n>` passes every guard
    // below the flag because the caret-id check is isNumeric over the tail; above it
    // issue.js rejects it as `invalid: TICK (caret dot)`. The id must reference a tick
    // A1 OWNS or the ISSUE dies on the ownership guard before the escape is reached:
    // index_tickers assigns 1=XCHAIN (gas preamble) and 2=PARENT (block 100), densely
    // and deterministically, so ^2 is PARENT. The witness below pins the verdict, so a
    // corpus change that moved the id would fail loudly rather than silently stop
    // testing the escape.
    blocks.push({ block: 106, time: t(106), txs: [
        { source: A1, data: 'ISSUE|0|^2.5|1000|100|0|caret dot' },
    ] });

    // 107: SHAPE 6 - a dotted ISSUE whose parent does not exist. Invalid on every
    // side, but below the flag getTokenInfo still INTERNS the unseen names into
    // index_tickers for free (R6/F11); above it the intern is suppressed. The
    // verdict is identical and the SIDE EFFECT is not, which is precisely the class
    // of leak a verdict-only comparison would miss.
    blocks.push({ block: 107, time: t(107), txs: [
        { source: A1, data: 'ISSUE|0|NOPARENT.7|1000|100|0|orphan child' },
    ] });

    // 108: SHAPE 7 - a single-ISSUE BATCH from an address holding no gas at all.
    // Below the flag the batch is valid and its one sub-command fails for funds;
    // above it the aggregate pre-check collapses it to `invalid: GAS (insufficient)`
    // and no sub-command runs (so the tick is never interned either).
    blocks.push({ block: 108, time: t(108), txs: [
        { source: A4, data: batchOf(['ISSUE|0|BROKE|1000|100|0|no gas']) },
    ] });

    // 109: SHAPE 8 setup - TWO dispensers behind ONE paid address (A3). Anyone may
    // open a second dispenser at an address they control, so this is the ordinary
    // -path one-payment-N-settlements shape, reachable with no batch at all.
    // Field layout as in modeBDispenser above (GIVE_OWNERSHIP sits between GIVE_AMOUNT
    // and GIVE_ESCROW); these two are Mode A, so FIAT_CODE and ORACLE_ADDRESS stay empty.
    // The collectors must first opt in to third-party dispensers (ADDRESS option 2) or
    // both dispensers die on `invalid: GET_ADDRESS (dispenser not permitted)`; same
    // in-block ordering the existing scenario 03/13 corpora use.
    blocks.push({ block: 109, time: t(109), txs: [
        { source: A3, data: 'ADDRESS|0|||2|' },
        { source: A5, data: 'ADDRESS|0|||2|' },
        { source: A1, data: `DISPENSER|0|BTC|${DTOK}|10|0|50|BTC|${BETA}|1|${A3}||||${FAR}|||` },
        { source: A1, data: `DISPENSER|0|BTC|${DTOK}|10|0|50|BTC|${BETA}|1|${A3}||||${FAR}|||` },
    ] });

    // 110: SHAPE 8 - one payment, two dispensers. Below the flag each dispenser
    // prices itself against the same untouched amount and both fill; above it the
    // local tally drains the payment and the second sees nothing left.
    blocks.push({ block: 110, time: t(110), txs: [
        { source: A2, destination: A3, data: `SEND|0|${BETA}|1|${A3}` },
    ] });

    // 111: SHAPE 9 setup - a dispenser whose escrow caps it at TWO fills, behind its
    // own collector so the block-110 pair cannot interfere.
    blocks.push({ block: 111, time: t(111), txs: [
        { source: A1, data: `DISPENSER|0|BTC|${DTOK}|10|0|20|BTC|${BETA}|1|${A5}||||${FAR}|||` },
    ] });

    // 112: SHAPE 9 - overpay it. The buyer sends 5 BETA at 1 BETA per fill but only
    // 2 fills of escrow remain, so 3 BETA of the payment buys nothing. Below the
    // flag the dispense row records the WHOLE payment as get_amount; above it, the
    // attributed cost.
    blocks.push({ block: 112, time: t(112), txs: [
        { source: A2, destination: A5, data: `SEND|0|${BETA}|5|${A5}` },
    ] });

    // 113: SHAPE 10 - the one-fee-for-N batch, R5's headline invariant, on the NATIVE
    // fee lane. The transaction's only output pays FEE_DESTINATION, which is what flips
    // detectFeePaymentMode to 'native', and it carries exactly ONE ORDER's worth of fee.
    // Below the flag nothing decrements TX_OUTPUTS between sub-commands, so all three
    // ORDERs judge the same untouched output and all three are valid: one command's fee
    // paid for N. Above it the ledger drains at expectedNative and the second and third
    // see an exhausted pool.
    // ORDER|0|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|GET_ESCROW|DESTINATION|EXPIRATION|...
    {
        const order = `ORDER|0|BTC|${PARENT}|10|0|BTC|${BETA}|20|0|${A1}|${ORDER_EXP}|||`;
        blocks.push({ block: 113, time: t(113), txs: [
            { source: A1, destination: FEE_DEST, amount: ONE_ORDER_FEE, data: batchOf([order, order, order]) },
        ] });
        // 114: the other half of the same invariant - N commands' worth yields N valid,
        // identically on both sides. It is the control that stops shape 10 from passing
        // for the trivial reason that the native lane rejects everything.
        blocks.push({ block: 114, time: t(114), txs: [
            { source: A1, destination: FEE_DEST, amount: THREE_ORDER_FEE, data: batchOf([order, order, order]) },
        ] });
    }

    // 115: SHAPE 12 - the oracle-fee half of R5b, the site every earlier run of this
    // tool named as unreached. THREE Mode B DISPENSER opens in one BATCH: the first two
    // name ORACLE_A, the third names ORACLE_B. The transaction's single output pays
    // ORACLE_A exactly ONE open's worth of oracle fee and pays ORACLE_B nothing.
    //
    // Below the flag nothing decrements the oracle's output between sub-commands, so
    // both ORACLE_A opens judge the same untouched 0.5 and BOTH are valid: one oracle
    // fee bought two dispensers. Above it the per-address tally drains at expectedFee
    // and the second open sees an exhausted pool.
    //
    // The ORACLE_B command is the string discriminator: it is rejected for a MISSING
    // output on every side, so the flag-ON divergence cannot be read as "the gate just
    // rejects Mode B dispensers".
    {
        const openA = modeBDispenser(ORACLE_A);
        const openB = modeBDispenser(ORACLE_B);
        blocks.push({ block: 115, time: t(115), txs: [
            { source: A1, destination: ORACLE_A, amount: ONE_ORACLE_FEE,
              data: batchOf([openA, openA, openB]) },
        ] });
        // 116: SHAPE 13 - the other half of the same invariant, and the same control
        // shape 11 is for shape 10: TWO opens paying TWO opens' worth must leave BOTH
        // valid on every side. Without it, shape 12 would pass for the trivial reason
        // that the flag rejects the second Mode B open no matter what was paid.
        blocks.push({ block: 116, time: t(116), txs: [
            { source: A1, destination: ORACLE_A, amount: TWO_ORACLE_FEE,
              data: batchOf([openA, openA]) },
        ] });
    }

    return blocks;
}
const LAST_BLOCK = 116;

// BTC regtest FEE_DESTINATION (configs/BTC.js). An output to it is what makes
// detectFeePaymentMode answer 'native' on a chain that otherwise falls back to the
// XCHAIN balance lane, which is how one corpus exercises BOTH fee lanes.
const FEE_DEST = 'mfeesX6rLE6V3WPg9tsbL2fHNS7E4rDAim';
// The ORDERs must actually OWE a fee, or the native lane is never entered and shape 10
// passes for the wrong reason. The unified expiration fee is free for the first
// UNIFIED_EXPIRATION_FEE_FREE_DAYS (90), so a 30-day order costs nothing; 200 days puts
// 110 chargeable days x GAS_SCHEDULE.EXPIRATION_PER_DAY (550) x GAS_PRICE (0.00001)
// = 0.605 XCHAIN on each one. The witness asserts payment_mode 1 so a schedule change
// that silently zeroed this would fail rather than pass vacuously.
const ORDER_EXP = T0 + 86400 * 200;

// One ORDER's native-coin fee, and three of them.
//
// With XCHAIN/USD and BTC/USD both seeded at 1, computeNativeFeeBand's expectedNative
// collapses to the XCHAIN fee itself, so these are just the ORDER's own expiration fee
// (0.605 XCHAIN at ORDER_EXP). Pinned as constants rather than computed
// here because a tool that re-derives the number it is testing agrees with itself; the
// witness assertions check the OBSERVED verdicts, so a schedule change breaks this
// loudly instead of quietly weakening the test.
const ONE_ORDER_FEE   = '0.60500000';
const THREE_ORDER_FEE = '1.81500000';

// The PRICE v1 oracle rows shapes 12/13 price themselves against, and the fee that
// falls out of them. computeOracleFee is
//     oraclePrice * GIVE_ESCROW / coinFiatPrice * feeFraction
// so 1.00 USD per DTOK, 50 DTOK escrowed, BTC/USD seeded at 1 and a 1% oracle fee give
// exactly 0.5 per open - three orders of magnitude above BTC's 546-satoshi dust floor,
// below which validateOracleFee requires no output at all and touches no tally.
// Both oracles get a row: ORACLE_B must fail shape 12 on its MISSING OUTPUT, not on
// "no effective oracle price", or the discriminator that separates the tally's verdict
// from a blanket rejection would not be testing what it claims.
const ORACLE_VALUE    = '1.00000000';   // USD per DTOK
const ORACLE_FEE_RATE = '0.01000000';   // 1% of projected proceeds
const ONE_ORACLE_FEE  = '0.50000000';
const TWO_ORACLE_FEE  = '1.00000000';

// Two finalized oracle rounds, seeded identically on every side. reference_block 0 so
// the (non-time-keyed, BTC-is-the-reference-chain) selection always finds them, and a
// block_timestamp inside the 1800s staleness window of every block that reads them.
const PRICE_ROUNDS = [
    { round: 1, pair: 'BTC/USD',    price: '1.00000000' },
    { round: 2, pair: 'XCHAIN/USD', price: '1.00000000' },
];
async function seedPrices(db) {
    for (const r of PRICE_ROUNDS)
        await db.doQuery(
            'INSERT INTO price_snapshots (round_number, coin_pair, price, reference_block, reference_chain, ' +
            'block_timestamp, validator_count, consensus_round, consensus_proof, status) ' +
            "VALUES (?, ?, ?, 0, 'BTC', ?, 1, 1, '', 'finalized')",
            [r.round, r.pair, r.price, T0]);

    // The two user oracles shapes 12/13 reference. `oracle_prices` is a HUB-MIRRORED
    // table (src/sql/oracle_prices.sql, filled by hub_db_sync): the indexer READS it on
    // the consensus path and never writes it, so publishing PRICE v1 actions in the
    // corpus would land rows in `prices` and leave this table empty. Seeding it is what
    // a hub-connected node actually presents to validateOracleFee, and it is seeded from
    // this ONE code path so all three sides get byte-identical rows.
    //
    // effective_at is T0, before every block in the corpus, so the 24h activation delay
    // is already served when the first block that reads it is processed. action_index is
    // only a tiebreaker within this table; it names no action in the indexer's ledger.
    let oracleActionIndex = 0;
    for (const oracle of [ORACLE_A, ORACLE_B])
        await db.doQuery(
            'INSERT INTO oracle_prices (source_address, source_chain, coin, tick, fiat, value, fee, ' +
            'memo, block_time, effective_at, action_index) ' +
            "VALUES (?, 'BTC', 'BTC', ?, 'USD', ?, ?, '', ?, ?, ?)",
            [oracle, DTOK, ORACLE_VALUE, ORACLE_FEE_RATE, T0, T0, ++oracleActionIndex]);
}

// --- old tree ---------------------------------------------------------------

// Materialize `ref` into a directory with `git archive`: a pure read of the object
// store, so nothing about the shared index, the worktree list or any ref changes.
// node_modules is symlinked from the live repo (the ref's own package.json is
// unchanged across the range this tool compares, verified by the caller).
function materializeOldTree(ref, dir) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    execSync('git archive ' + JSON.stringify(ref) + ' | tar -x -C ' + JSON.stringify(dir), { cwd: REPO });
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
    return dir;
}

function sha256File(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
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

// --- witnesses --------------------------------------------------------------

async function batchVerdicts(q) {
    const rows = await q(
        'SELECT b.action_index, s.status FROM batches b ' +
        'LEFT JOIN index_statuses s ON s.id = b.status_id ORDER BY b.action_index');
    return rows.map(r => String(r.status));
}
async function tickExists(q, tick) {
    const rows = await q('SELECT id FROM index_tickers WHERE tick = ?', [tick]);
    return rows.length > 0;
}
// ISSUE verdicts in one block, addressed by BLOCK rather than by TICK: a caret-form
// ISSUE can land with a NULL tick_id (a known defect), so a tick join
// would silently return nothing and read as "no such issue".
async function issueStatusAtBlock(q, blockIndex) {
    const rows = await q(
        'SELECT s.status FROM issues i ' +
        'JOIN actions a ON a.action_index = i.action_index ' +
        'LEFT JOIN index_statuses s ON s.id = i.status_id ' +
        'WHERE a.block_index = ? ORDER BY i.action_index', [blockIndex]);
    return rows.map(r => String(r.status));
}
// Every dispense, tagged with the COLLECTOR address its dispenser sits behind
// (dispensers.get_address_id). dispenses.destination_id is the BUYER, so the
// collector is the only thing that tells shape 8's pair apart from shape 9.
async function dispenseRows(q) {
    const rows = await q(
        'SELECT d.action_index, d.dispenser_action_index, d.give_amount, d.get_amount, ' +
        '       ab.address AS buyer, ac.address AS collector, s.status ' +
        'FROM dispenses d ' +
        'LEFT JOIN dispensers      p  ON p.action_index = d.dispenser_action_index ' +
        'LEFT JOIN index_addresses ab ON ab.id = d.destination_id ' +
        'LEFT JOIN index_addresses ac ON ac.id = p.get_address_id ' +
        'LEFT JOIN index_statuses  s  ON s.id = d.status_id ORDER BY d.action_index');
    return rows.map(r => ({
        action_index: String(r.action_index),
        dispenser: String(r.dispenser_action_index),
        give: String(r.give_amount), get: String(r.get_amount),
        buyer: r.buyer === null ? null : String(r.buyer),
        collector: r.collector === null ? null : String(r.collector),
        status: String(r.status),
    }));
}
// ORDER verdicts in one block, with the native fee each one was actually charged.
async function orderRowsAtBlock(q, blockIndex) {
    const rows = await q(
        'SELECT o.action_index, s.status, f.native_coin_amount, f.payment_mode ' +
        'FROM orders o ' +
        'JOIN actions a ON a.action_index = o.action_index ' +
        'LEFT JOIN index_statuses s ON s.id = o.status_id ' +
        'LEFT JOIN fees f ON f.action_index = o.action_index ' +
        'WHERE a.block_index = ? ORDER BY o.action_index', [blockIndex]);
    return rows.map(r => ({ status: String(r.status),
                            native: r.native_coin_amount === null ? null : String(r.native_coin_amount),
                            mode: r.payment_mode === null || r.payment_mode === undefined ? null : Number(r.payment_mode) }));
}

// Mode B DISPENSER verdicts in one block, tagged with the oracle each one named.
// Addressed by BLOCK and ordered by action_index, so a sub-command that was rejected
// (and therefore escrowed nothing and moved no balance) is still counted in position:
// createDispenser records the invalid attempt, which is the only reason the
// one-fee-two-opens divergence is visible in a table at all.
async function oracleDispensersAtBlock(q, blockIndex) {
    const rows = await q(
        'SELECT d.action_index, s.status, ao.address AS oracle ' +
        'FROM dispensers d ' +
        'JOIN actions a ON a.action_index = d.action_index ' +
        'LEFT JOIN index_addresses ao ON ao.id = d.oracle_address_id ' +
        'LEFT JOIN index_statuses  s  ON s.id = d.status_id ' +
        'WHERE a.block_index = ? ORDER BY d.action_index', [blockIndex]);
    return rows.map(r => ({ status: String(r.status),
                            oracle: r.oracle === null ? null : String(r.oracle) }));
}

async function countRows(q, table) {
    const rows = await q('SELECT COUNT(*) AS n FROM `' + table + '`');
    return Number(rows[0].n);
}

// --- main -------------------------------------------------------------------

async function main() {
    const opts = parseArgs();
    const p    = dbParams();
    const NS   = process.env.TEST_DB_NS || 'xchain_test_a7';
    const DB   = { dec: NS + '_dec', OLD: NS + '_old', OFF: NS + '_off', ON: NS + '_on' };

    console.log('# A7 below-the-flag replay equivalence for ' + GATE);
    console.log('# old ref: ' + opts.oldRef + '   HEAD: ' + execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim());
    console.log('# db: ' + p.user + '@' + p.host + ':' + p.port + '  schemas ' + Object.values(DB).join(', '));

    // ---- old tree ---------------------------------------------------------
    section('N4 harness parity and the old tree');
    const workdir = opts.workdir || path.join(os.tmpdir(), 'xchain-a7-oldtree');
    let oldRoot;
    try {
        oldRoot = materializeOldTree(opts.oldRef, workdir);
    } catch (e) {
        console.error('cannot materialize ' + opts.oldRef + ': ' + e.message);
        process.exit(2);
    }
    info('old tree at ' + oldRoot);

    // The two sides may differ ONLY in src. Asserting the harness happened to be
    // identical made that invariant hostage to the harness never being fixed: when
    // indexer-launcher.js gained production's output-fanout collapse (spec row 49),
    // this check went red on a CORRECT change and the tool refused to run at all.
    //
    // So the test scaffolding is now OVERLAID from the working tree onto the old
    // tree rather than compared to it. That makes "one harness, two src trees" true
    // by construction instead of true by luck, which is the property the comparison
    // actually needs. It is also what lets the old side benefit from a harness FIX:
    // replaying old product code through a harness that mis-modelled execution count
    // would have measured the harness, not the code.
    //
    // Only pure test scaffolding is overlaid. package.json stays a comparison,
    // because overlaying it would hand the old tree a dependency set its src was
    // never installed against, and a mismatch there is a real reason to stop.
    const HARNESS_OVERLAY = [
        'test/integration/setup/indexer-launcher.js',
        'test/integration/setup/db-connection.js',
        'test/integration/setup/equivalence.js',
        'test/integration/setup/decoder-seeder.js',
    ];
    const HARNESS_ASSERT = ['package.json'];
    let harnessOk = true;
    for (const rel of HARNESS_OVERLAY) {
        const a = path.join(REPO, rel), b = path.join(oldRoot, rel);
        if (!fs.existsSync(a)) {
            harnessOk = false;
            check(false, 'harness file present to overlay: ' + rel, 'missing from the working tree');
            continue;
        }
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(a, b);
        const same = sha256File(a) === sha256File(b);
        if (!same) harnessOk = false;
        check(same, 'harness overlaid onto the old tree: ' + rel,
            same ? '' : 'copy did not take; the two sides would run different harnesses');
    }
    for (const rel of HARNESS_ASSERT) {
        const a = path.join(REPO, rel), b = path.join(oldRoot, rel);
        const same = fs.existsSync(b) && sha256File(a) === sha256File(b);
        if (!same) harnessOk = false;
        check(same, 'harness file identical in both trees: ' + rel,
            same ? '' : 'this file MOVED between ' + opts.oldRef + ' and HEAD; the comparison would confound harness with product');
    }
    if (!harnessOk) { console.log('\nFAILED: harness parity'); process.exit(1); }

    // The src files that DID move: report them, so the reader knows what surface
    // the comparison is actually about.
    const movedSrc = execSync('git diff --name-only ' + JSON.stringify(opts.oldRef) + ' HEAD -- src/', { cwd: REPO })
        .toString().trim().split('\n').filter(Boolean);
    info('src files changed across the range under test: ' + movedSrc.join(', '));

    // ---- databases and corpus --------------------------------------------
    section('corpus');
    const admin = await connect(p, undefined);
    for (const name of Object.values(DB)) {
        await admin.query('DROP DATABASE IF EXISTS `' + name + '`');
        await admin.query('CREATE DATABASE `' + name + '`');
    }
    await admin.end();

    // The decoder schema loader and the seeders are the integration tier's own, so
    // the corpus is shaped exactly like the data a real decoder hands the indexer.
    process.env.TEST_DB_HOST = p.host;
    process.env.TEST_DB_PORT = String(p.port);
    process.env.TEST_DB_USER = p.user;
    process.env.TEST_DB_PASS = p.pass;
    process.env.TEST_DECODER_DB = DB.dec;
    process.env.INDEXER_COIN    = 'BTC';
    process.env.INDEXER_NETWORK = 'regtest';

    const dbc     = require(path.join(REPO, 'test/integration/setup/db-connection.js'));
    const Seeder  = require(path.join(REPO, 'test/integration/setup/decoder-seeder.js'));
    const { seedGas } = require(path.join(REPO, 'test/integration/setup/gas-seeder.js'));
    await dbc.createDecoderSchema();

    const seeder = new Seeder(dbc.decoderQuery);
    // A4 is deliberately absent from the gas preamble: shape 7 needs a source that
    // provably cannot pay for an issuance.
    await seedGas(seeder, { blockIndex: GAS_B, blockTime: T0 - STEP, addresses: [A1, A2, A3, A5], amount: '1000' });
    const blocks = corpus();
    for (const b of blocks) await seeder.seedBlock(b.block, b.time, b.txs);
    info('seeded ' + (blocks.length + 1) + ' decoder blocks (' + GAS_B + '..' + LAST_BLOCK + '), ' +
         blocks.reduce((n, b) => n + b.txs.length, 0) + ' transactions + gas preamble');

    // ---- run the three sides ---------------------------------------------
    section('sides');
    const sides = [
        { key: 'OLD', root: oldRoot, gate: 'natural', db: DB.OLD, label: 'OLD (' + opts.oldRef + ')' },
        { key: 'OFF', root: REPO,    gate: 'off',     db: DB.OFF, label: 'HEAD, flag UNARMED' },
        { key: 'ON',  root: REPO,    gate: 'natural', db: DB.ON,  label: 'HEAD, flag genesis-active (control)' },
    ];
    const reports = {};
    for (const s of sides) {
        const env = Object.assign({}, process.env, {
            A7_SIDE_ROOT: s.root, A7_SIDE_GATE: s.gate,
            TEST_INDEXER_DB: s.db, TEST_DECODER_DB: DB.dec,
            INDEXER_COIN: 'BTC', INDEXER_NETWORK: 'regtest',
        });
        const r = spawnSync(process.execPath, [__filename, '--side'], { env, encoding: 'utf8', maxBuffer: 1024 * 1024 * 256 });
        const line = String(r.stdout || '').split('\n').find(l => l.startsWith(SIDE_MARK));
        if (r.status !== 0 || !line) {
            console.error('side ' + s.key + ' failed (exit ' + r.status + ')');
            console.error(String(r.stderr || '').split('\n').slice(-25).join('\n'));
            console.error(String(r.stdout || '').split('\n').slice(-15).join('\n'));
            process.exit(1);
        }
        reports[s.key] = JSON.parse(line.slice(SIDE_MARK.length));
        info(s.key.padEnd(3) + ' ' + s.label.padEnd(42) + reports[s.key].blocks + ' blocks in ' +
             (reports[s.key].ms / 1000).toFixed(1) + 's');
    }

    // ---- N1: the gate really was where we said it was ---------------------
    section('N1 gate state proven per side');
    check(reports.OLD.gate.registered === false,
        'OLD does not know ' + GATE + ' at all',
        reports.OLD.gate.registered ? 'the old ref already registers the flag; --old-ref is wrong' : '');
    check(reports.OFF.gate.registered === true && reports.OFF.gate.regtest_time === UNARMED &&
          reports.OFF.gate.mainnet_time === UNARMED,
        'OFF registers ' + GATE + ' at the UNARMED sentinel on every network',
        JSON.stringify(reports.OFF.gate));
    check(reports.ON.gate.registered === true && reports.ON.gate.regtest_time === 0,
        'ON registers ' + GATE + ' genesis-active on regtest (as shipped)',
        JSON.stringify(reports.ON.gate));
    check(reports.OLD.blocks === reports.OFF.blocks && reports.OFF.blocks === reports.ON.blocks,
        'all three sides processed the same block count',
        'OLD=' + reports.OLD.blocks + ' OFF=' + reports.OFF.blocks + ' ON=' + reports.ON.blocks);

    // ---- witnesses on the OLD side ---------------------------------------
    section('N3 witnesses: what the OLD code actually did with the corpus');
    const conns = {};
    for (const k of ['OLD', 'OFF', 'ON']) conns[k] = await connect(p, DB[k]);
    const q = { OLD: queryFnFor(conns.OLD), OFF: queryFnFor(conns.OFF), ON: queryFnFor(conns.ON) };

    const wOld = await witnesses(q.OLD);
    const wOn  = await witnesses(q.ON);
    printWitnesses('OLD', wOld);
    printWitnesses('ON ', wOn);

    check(wOld.batchVerdicts[0] === 'invalid: ISSUE (limit)',
        'shape 1 (parent + 50 children): OLD rejects the whole batch on the per-action limit',
        'got ' + JSON.stringify(wOld.batchVerdicts[0]));
    check(wOld.batchVerdicts[1] === 'valid',
        'shape 2 (251 commands): OLD has no cap and runs the batch',
        'got ' + JSON.stringify(wOld.batchVerdicts[1]));
    check(wOld.batchVerdicts[2] === 'valid',
        'shape 3 (250 commands): OLD runs it',
        'got ' + JSON.stringify(wOld.batchVerdicts[2]));
    check(wOld.batchVerdicts[3] === 'invalid: ISSUE (limit)',
        'shape 4 (two undotted ISSUEs): rejected on OLD too (pre-existing rule)',
        'got ' + JSON.stringify(wOld.batchVerdicts[3]));
    check(wOld.caretDot.length > 0 && !wOld.caretDot.some(s => s.includes('caret dot')),
        'shape 5 (caret-dot ISSUE): OLD does NOT know the caret-dot rejection',
        'got ' + JSON.stringify(wOld.caretDot));
    check(wOld.internedOrphan === true,
        'shape 6 (parentless dotted ISSUE): OLD interned the tick for free',
        'index_tickers has NOPARENT.7 = ' + wOld.internedOrphan);
    check(wOld.batchVerdicts[4] === 'valid',
        'shape 7 (gasless single-ISSUE batch): OLD has no aggregate pre-check',
        'got ' + JSON.stringify(wOld.batchVerdicts[4]));
    check(wOld.dispensesAt(A3).length === 2 && wOld.dispensesAt(A3).every(d => d.give === '10'),
        'shape 8 (two dispensers, one payment): OLD fills BOTH off the same 1 BETA',
        JSON.stringify(wOld.dispensesAt(A3)));
    check(wOld.dispensesAt(A5).length === 1 && wOld.dispensesAt(A5)[0].get === '5',
        'shape 9 (overpaid dispenser): OLD records the WHOLE payment as get_amount',
        JSON.stringify(wOld.dispensesAt(A5)));
    check(wOld.ordersOneFee.length === 3 && wOld.ordersOneFee.every(o => o.status === 'valid'),
        'shape 10 (one ORDER\'s native fee, three ORDERs): OLD validates ALL THREE off one output',
        JSON.stringify(wOld.ordersOneFee));
    check(wOld.ordersOneFee.every(o => o.mode === 1),
        'shape 10 really ran on the NATIVE fee lane (payment_mode 1), not the XCHAIN fallback',
        JSON.stringify(wOld.ordersOneFee.map(o => o.mode)));
    check(wOld.ordersThreeFee.length === 3 && wOld.ordersThreeFee.every(o => o.status === 'valid'),
        'shape 11 (three ORDERs\' worth): all three valid on OLD (the not-everything-rejects control)',
        JSON.stringify(wOld.ordersThreeFee));
    check(wOld.oracleOneFee.length === 3 &&
          wOld.oracleOneFee[0].status === 'valid' && wOld.oracleOneFee[1].status === 'valid',
        'shape 12 (one oracle fee, two opens on that oracle): OLD validates BOTH off one output',
        JSON.stringify(wOld.oracleOneFee));
    check(wOld.oracleOneFee.length === 3 && wOld.oracleOneFee[2].oracle === ORACLE_B &&
          wOld.oracleOneFee[2].status === 'invalid: ORACLE_ADDRESS (missing oracle fee output)',
        'shape 12: the UNPAID oracle\'s open is rejected for a missing output, on OLD too',
        JSON.stringify(wOld.oracleOneFee[2]));
    check(wOld.oracleTwoFee.length === 2 && wOld.oracleTwoFee.every(d => d.status === 'valid'),
        'shape 13 (two opens\' worth): both valid on OLD (the not-everything-rejects control)',
        JSON.stringify(wOld.oracleTwoFee));

    // ---- THE A7 ASSERTION -------------------------------------------------
    section('A7: OLD vs HEAD-with-the-flag-unarmed');
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
    check(hashOk, 'consensus hash chain identical at all ' + chainOLD.length + ' blocks (ledger/actions/contracts + state)',
        hashOk ? 'first block ' + chainOLD[0].block_index + ' ledger=' + String(chainOLD[0].ledger).slice(0, 16) + '...  ' +
                 'last block ' + chainOLD[chainOLD.length - 1].block_index + ' ledger=' +
                 String(chainOLD[chainOLD.length - 1].ledger).slice(0, 16) + '...'
               : hashErr);

    const dOffOld = diffStates(stateOLD, stateOFF);
    check(dOffOld.length === 0, 'every table byte-identical OLD vs OFF (' + Object.keys(stateOLD).length + ' tables compared, strict mode)',
        dOffOld.length === 0
            ? 'row totals: ' + Object.values(stateOLD).reduce((n, r) => n + r.length, 0)
            : JSON.stringify(dOffOld, null, 2));

    // ---- N2: the harness detects a divergence -----------------------------
    section('N2 negative control: the SAME comparator against the flag ON');
    const dOnOld = diffStates(stateOLD, stateON);
    check(dOnOld.length > 0,
        'flipping the gate ON moves committed state (so a pass above is not vacuous)',
        dOnOld.length > 0
            ? dOnOld.length + ' tables differ: ' + dOnOld.map(d => d.table + '(' + d.aRows + '->' + d.bRows + ')').join(', ')
            : 'ON matched OLD: the corpus no longer reaches the gated code and the A7 pass above proves NOTHING');

    let onHashDiverges = false;
    try { eq.assertHashChainsEqual(chainOLD, chainON, 'OLD', 'ON'); }
    catch (e) { onHashDiverges = true; }
    check(onHashDiverges, 'and it moves the CONSENSUS HASH CHAIN, not just local rows',
        onHashDiverges ? 'first divergent block reported by the same assertHashChainsEqual the pass above used'
                       : 'the gate moved rows but not the hash chain, which would mean the comparison above is weaker than it looks');

    // Targeted: the tables the change is SUPPOSED to move must be among them.
    const movedTables = new Set(dOnOld.map(d => d.table));
    for (const t of ['batches', 'issues', 'index_tickers', 'dispenses', 'dispensers'])
        check(movedTables.has(t), 'control moves `' + t + '` (the surface this spec changes)',
            movedTables.has(t) ? '' : 'the corpus does not reach the gated code that writes ' + t);

    // And the shapes that must NOT move: shape 3 and shape 4 verdicts.
    // The native-fee tally specifically: with the flag ON, one command's worth must
    // fund exactly one command, and three commands' worth must still fund three.
    const onValidOne   = wOn.ordersOneFee.filter(o => o.status === 'valid').length;
    const onValidThree = wOn.ordersThreeFee.filter(o => o.status === 'valid').length;
    check(onValidOne === 1,
        'control reaches R5\'s native-fee tally: one ORDER\'s fee funds exactly ONE ORDER with the flag ON',
        'valid=' + onValidOne + ' of ' + wOn.ordersOneFee.length + ' ' + JSON.stringify(wOn.ordersOneFee));
    check(onValidThree === 3,
        'and three ORDERs\' worth still funds three (the tally drains, it does not just reject)',
        'valid=' + onValidThree + ' of ' + wOn.ordersThreeFee.length);

    // The ORACLE-FEE tally, the site every earlier run of this tool reported as the one
    // it did not reach. The witness is POSITIVE and attributable: the second open on the
    // paid oracle must flip valid -> invalid, and its error string must be the tally's
    // own (`insufficient oracle fee`), which nothing but the per-address pool arithmetic
    // in validateOracleFee produces.
    const onOracleValid  = wOn.oracleOneFee.filter(d => d.status === 'valid').length;
    const onOracleSecond = wOn.oracleOneFee.length > 1 ? wOn.oracleOneFee[1].status : '(no row)';
    check(onOracleValid === 1,
        'control reaches R5b\'s ORACLE-fee tally: one oracle fee funds exactly ONE Mode B open with the flag ON',
        'valid=' + onOracleValid + ' of ' + wOn.oracleOneFee.length + ' ' + JSON.stringify(wOn.oracleOneFee));
    check(onOracleSecond.includes('insufficient oracle fee'),
        'and it fails with the TALLY\'s error string, not the missing-output one (attributable to oracleFeeConsumed)',
        'second open on the paid oracle: ' + JSON.stringify(onOracleSecond));
    check(wOn.oracleOneFee.length === 3 &&
          wOn.oracleOneFee[2].status === wOld.oracleOneFee[2].status,
        'and the UNPAID oracle\'s open still reports the MISSING-output verdict, unchanged by the gate',
        'OLD=' + JSON.stringify(wOld.oracleOneFee[2] && wOld.oracleOneFee[2].status) +
        ' ON=' + JSON.stringify(wOn.oracleOneFee[2] && wOn.oracleOneFee[2].status));
    check(wOn.oracleTwoFee.length === 2 && wOn.oracleTwoFee.every(d => d.status === 'valid'),
        'and two opens\' worth still funds two (the oracle tally drains, it does not just reject Mode B)',
        JSON.stringify(wOn.oracleTwoFee));

    check(wOn.batchVerdicts[2] === wOld.batchVerdicts[2] && wOn.batchVerdicts[3] === wOld.batchVerdicts[3],
        'control is TARGETED: the exactly-250 batch and the two-undotted batch reach the same verdict with the flag ON',
        'OLD=' + JSON.stringify([wOld.batchVerdicts[2], wOld.batchVerdicts[3]]) +
        ' ON=' + JSON.stringify([wOn.batchVerdicts[2], wOn.batchVerdicts[3]]));

    // ---- coverage statement ----------------------------------------------
    section('coverage of this run');
    info('COVERED, driven on both sides: the batch limit scan (250-command cap, dotted-TICK');
    info('  exemption, error precedence), the caret-dot TICK rejection, the ticker-intern');
    info('  gating, the aggregate gas pre-check, R5\'s native-coin fee ledger on the NATIVE');
    info('  lane, R5b\'s per-ORACLE fee tally in validateOracleFee (Mode B DISPENSER opens');
    info('  against a PRICE v1 oracle), and the ORDINARY non-batch dispense tally in both its');
    info('  shapes (two dispensers behind one paid address, and the get_amount attribution of');
    info('  an overpaid SEND).');
    info('NOT COVERED: COINPAY\'s settlement tally, which is STRUCTURALLY unreachable inside a');
    info('  BATCH today because the decoder never captures a payment output for one (spec row');
    info('  21). It is the only gated site this tool leaves unmeasured, and there is no wire');
    info('  path to measure it on.');
    info('COVERED BUT NOT IN BOTH DIRECTIONS: oracleFeeConsumed is keyed BY ORACLE ADDRESS, and');
    info('  the POSITIVE witness for that keying (one transaction paying two different oracles');
    info('  enough for both) needs a two-output transaction. That is now CONSTRUCTIBLE and');
    info('  simply unbuilt: the launcher applies collapseOutputFanout like XChainIndexer.start');
    info('  and the seeder can emit a full output set (spec row 49). It is no longer blocked.');
    info('  What IS pinned: an unpaid oracle\'s sub-command reports the MISSING-output verdict');
    info('  identically on every side, so the paid oracle\'s exhausted pool is not leaking into');
    info('  it as a blanket rejection.');

    for (const k of ['OLD', 'OFF', 'ON']) { try { await conns[k].end(); } catch (e) {} }
    try { await dbc.closeAll(); } catch (e) {}

    if (!opts.keep) {
        const a2 = await connect(p, undefined);
        for (const name of Object.values(DB)) await a2.query('DROP DATABASE IF EXISTS `' + name + '`');
        await a2.end();
        fs.rmSync(workdir, { recursive: true, force: true });
    } else {
        info('kept: schemas ' + Object.values(DB).join(', ') + ' and old tree ' + workdir);
    }

    console.log(failures ? '\nFAILED: ' + failures + ' assertion(s)' : '\nALL ASSERTIONS HOLD (A7 evidence for the surfaces listed above)');
    process.exit(failures ? 1 : 0);
}

async function witnesses(qf) {
    const verdicts = await batchVerdicts(qf);
    const disp     = await dispenseRows(qf);
    return {
        batchVerdicts:  verdicts,
        caretDot:       await issueStatusAtBlock(qf, 106),
        internedOrphan: await tickExists(qf, 'NOPARENT.7'),
        internedBroke:  await tickExists(qf, 'BROKE'),
        dispenses:      disp,
        dispensesAt:    (addr) => disp.filter(d => d.collector === addr),
        ordersOneFee:   await orderRowsAtBlock(qf, 113),
        ordersThreeFee: await orderRowsAtBlock(qf, 114),
        oracleOneFee:   await oracleDispensersAtBlock(qf, 115),
        oracleTwoFee:   await oracleDispensersAtBlock(qf, 116),
        counts: {
            actions:       await countRows(qf, 'actions'),
            issues:        await countRows(qf, 'issues'),
            sends:         await countRows(qf, 'sends'),
            index_tickers: await countRows(qf, 'index_tickers'),
            dispenses:     disp.length,
        },
    };
}

function printWitnesses(label, w) {
    info(label + ' batch verdicts: ' + JSON.stringify(w.batchVerdicts));
    info(label + ' caret-dot ISSUE: ' + JSON.stringify(w.caretDot) +
         '   NOPARENT.7 interned: ' + w.internedOrphan + '   BROKE interned: ' + w.internedBroke);
    info(label + ' dispenses: ' + JSON.stringify(w.dispenses));
    info(label + ' native-fee ORDERs  1x fee: ' + JSON.stringify(w.ordersOneFee) +
         '   3x fee: ' + JSON.stringify(w.ordersThreeFee));
    info(label + ' Mode B DISPENSERs  1x oracle fee: ' + JSON.stringify(w.oracleOneFee));
    info(label + ' Mode B DISPENSERs  2x oracle fee: ' + JSON.stringify(w.oracleTwoFee));
    info(label + ' row counts: ' + JSON.stringify(w.counts));
}

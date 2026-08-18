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
 * MEASURE WHAT AN `EXECUTE` SUB-COMMAND COSTS THE BLOCK LOOP, RELATIVE TO AN
 * ORDINARY SUB-COMMAND.
 *
 * WHY THIS EXISTS. The weighted BATCH budget prices every ordinary sub-command at
 * 1 and needs a number for `EXECUTE`/`XEXEC`. The spec refuses to guess it and
 * refuses to derive it from gas, because gas prices the ECONOMIC cost to the payer
 * while the budget bounds INDEXER WORK. It names the honest input: "a measurement
 * of what N concurrent VM executions cost the block loop". This tool takes that
 * measurement and reports the RATIO, because the weight is a ratio: how many
 * minimal SENDs' worth of block-loop work is one EXECUTE.
 *
 * ------------------------------------------------------------------------------
 * WHAT IT MEASURES
 *
 * It drives the REAL indexer block loop (src/XChainIndexer.js's inner body, see
 * "FIDELITY" below) over a purpose-built decoder corpus in a throwaway MariaDB,
 * with the REAL isolated-vm-backed xchain-vm in its production `subprocess`
 * execution mode. Each measured block carries exactly ONE transaction: a BATCH of
 * N sub-commands, all of one arm. Three arms, plus a control:
 *
 *   send        N x `SEND|0|XCHAIN|1|<dest>|`  - the unit of the weight model,
 *               weight 1 by definition. One action index, its mappings, a ledger
 *               row pair. No VM.
 *   send-tx     the SAME N SENDs as N separate TRANSACTIONS rather than one BATCH.
 *               The baseline for the DEPLOY arms, which cannot be batched (see
 *               below), so a DEPLOY ratio is never formed against a differently
 *               shaped denominator. Its agreement with `send` is also the evidence
 *               that the BATCH wrapper itself costs nothing per sub-command.
 *   exec-cheap  N x `EXECUTE|0|<ci>|noop`      - a contract method that returns a
 *               constant and touches no state. This is the FLOOR of an EXECUTE:
 *               what the VM costs when the contract does nothing at all.
 *   exec-worst  N x `EXECUTE|0|<ci>|burn`      - a contract method that spins until
 *               the gas ceiling clamps it. This is the CEILING of an EXECUTE and
 *               it is the number the weight has to respect, because the budget is
 *               a denial-of-service bound and an attacker picks the contract.
 *   exec-state  N x `EXECUTE|0|<ci>|fill`      - a contract method that SUCCEEDS
 *               while writing STATE_KEYS state keys, so its contract_state rows
 *               really commit. `burn` above is a pure compute burn and its state
 *               changes roll back at the resource clamp, so on its own it would
 *               leave the DB-write shape of an expensive EXECUTE unmeasured.
 *   deploy      N x `DEPLOY|0|<code>|<gas>|`   - a small contract, NO constructor
 *               params, so the VM lints, validates and compiles but runs no
 *               constructor. Isolates deployment's non-constructor cost.
 *   deploy-ctor N x the same with CONSTRUCTOR_PARAMS set, so `initialize` really
 *               runs in the isolate and its state write really commits. The
 *               difference against `deploy` is what a constructor costs.
 *   deploy-big  N x a contract padded with real methods to ~DEPLOY_BIG_BYTES, no
 *               constructor. The difference against `deploy` is what CODE SIZE
 *               costs. The gas schedule carries VM_DEPLOY_PER_BYTE, i.e. the
 *               platform already believes size matters, but gas is the grounding
 *               this spec rejected, so the belief is measured rather than inherited.
 *   deploy-worst  N x max-size code WITH a constructor that spins to the resource
 *               clamp: both DEPLOY cost terms stacked. The deploy is rejected at
 *               the clamp and that is the point, because the block loop has already
 *               paid for the lint, the validate, the compile and the burn. This is
 *               the DEPLOY analogue of `exec-worst` and it is the number a
 *               DoS-grounded DEPLOY weight has to respect.
 *   empty       a block with no transactions   - the fixed per-block floor, so the
 *               fixed cost is measured rather than assumed away.
 *
 * WHY THE DEPLOY ARMS ARE SEPARATE TRANSACTIONS AND NOT A BATCH, which is a venue
 * fact and not a choice: `gatedActionLimits['DEPLOY'] = 1` in src/actions/batch.js
 * is live under BATCH_ISSUANCE_LIMITS, and that flag is genesis-active on regtest,
 * so a BATCH carrying two DEPLOYs is refused as `invalid: DEPLOY (limit)` before
 * either one runs. N DEPLOYs in one BATCH is therefore not a shape this chain can
 * produce and there is nothing to time. N DEPLOYs in one BLOCK is the same unit of
 * block-loop work and it IS producible, so that is what is measured, against the
 * `send-tx` baseline which is shaped identically.
 *
 * Each (arm, N) cell is repeated `--reps` times and the arms are INTERLEAVED
 * within a repetition, so a load spike on a shared box lands on every arm rather
 * than on one. The reported figure is the median across repetitions and the tool
 * prints every raw timing.
 *
 * The per-sub-command cost of an arm is the SLOPE of an ordinary least-squares fit
 * of block wall time against N, not a single division. The slope separates the
 * per-sub-command cost from the fixed per-block cost (transaction begin/commit,
 * createBlock, sanityCheck, market updates), which is what makes the two arms
 * comparable at all. The intercept is reported beside it and should land near the
 * empty-block control; when it does not, the fit is reported as suspect.
 *
 * ------------------------------------------------------------------------------
 * WHAT IT DOES NOT MEASURE - read this before quoting a number.
 *
 *  - NOT CONCURRENCY. The spec's phrase is "N concurrent VM executions", but the
 *    indexer does not execute concurrently: ProcessExecutor dispatches to ONE
 *    forked worker and the block loop awaits each sub-command in turn. N in one
 *    block is N sequential executions. The measurement is of that, which is what
 *    the block loop actually does.
 *  - NOT A REAL CHAIN. There is no P2P, no decoder, no node RPC, no mempool. The
 *    corpus is seeded straight into a decoder-shaped database, which is the same
 *    vehicle test/integration and bin/verify-batch-limits-replay-equivalence.js
 *    use. Absolute milliseconds are therefore venue figures. The RATIO is the
 *    deliverable and it is far more portable than either absolute.
 *  - NOT MAINNET HARDWARE. Timings come from whatever box the run happens on, and
 *    that box is shared. Variance across repetitions is reported for exactly this
 *    reason; a run whose spread is wide should be re-run, not quoted.
 *  - NOT EVERY CONTRACT. `exec-worst` is a compute burn against the gas ceiling and
 *    `exec-state` is a committed-state-write shape. A contract that instead emits
 *    the maximum permitted actions, or reads the maximum permitted state, is a
 *    DIFFERENT worst case that this tool does not build. The reported ceiling is
 *    therefore a LOWER bound on the true worst case.
 *  - NOT THE WEIGHT DECISION. The tool prints a recommendation; ratifying it is
 *    the operator's row (spec row 2).
 *
 * ------------------------------------------------------------------------------
 * FIDELITY: how the driven loop relates to production
 *
 * The block body here mirrors XChainIndexer.start()'s inner block body, and it
 * mirrors it more closely than test/integration's processBlocks() does, in one way
 * that matters for this measurement specifically: it calls `vm.beginBlock()` and
 * `vm.endBlock()` around the transaction loop. Production does; processBlocks()
 * does not. Those two calls own the per-block contract COMPILATION CACHE, so
 * omitting them would measure a cache that production clears at a different rhythm,
 * and the whole question here is whether per-execution VM cost amortizes across N.
 *
 * Deliberately absent, because none of it fires on this corpus and each would add
 * fixed per-block cost that the regression intercept absorbs anyway: the hub-sync
 * barriers, the reorg pass, the cross-chain settlement/call passes, the anchor
 * reward derivation, the BET/VOTE/attestation/cooldown passes, and the SPV state
 * commitment. What IS kept is everything a BATCH transaction actually touches plus
 * the per-block bookkeeping every block pays: beginTransaction, blockIndex stamping,
 * output-fanout collapse, processTransaction, processExpirations, processCancellations,
 * createBlock, processMarketUpdates, sanityCheck, commitTransaction.
 *
 * ------------------------------------------------------------------------------
 * ANTI-FALSE-GREEN CONTROLS. A timing run over work that never happened is worse
 * than no run, so every measured block is VERIFIED after the fact and a failed
 * verification aborts the run instead of reporting a number:
 *
 *   V1. Every measured block must carry exactly N sub-command action rows of the
 *       arm's action. A BATCH that was refused wholesale writes one invalid record
 *       and would otherwise time as "very cheap EXECUTEs".
 *   V2. Every `exec-*` block must carry N rows in contract_executions. An EXECUTE
 *       that failed before reaching the VM (unknown contract, unaffordable) costs
 *       nothing and would understate the weight.
 *   V3. `exec-cheap` executions must have gas_used > 0 and status `valid`; the
 *       contract really ran. `exec-worst` executions must have gas_used equal to
 *       the configured gas ceiling; the burn really reached the clamp.
 *   V4. Every `send` block must carry N rows in `sends` with status `valid`.
 *
 * ------------------------------------------------------------------------------
 * VENUE. isolated-vm does not build on macOS, so this must run on a Linux box on
 * Node 22. It needs a MariaDB the configured user may CREATE schemas on; the
 * simplest venue is the throwaway container bin/run-db-tiers.sh already starts.
 *
 *   TEST_DB_HOST TEST_DB_PORT TEST_DB_USER TEST_DB_PASS   (fall back to .env
 *     INDEXER_DB_* exactly like test/integration/setup/db-connection.js)
 *   TEST_DECODER_DB TEST_INDEXER_DB                       (schema names)
 *   XCHAIN_DECODER_SQL_PATH                               (xchain-decoder/src/sql)
 *   INDEXER_COIN=BTC INDEXER_NETWORK=regtest
 *
 * USAGE
 *   node bin/measure-batch-execute-cost.js
 *   node bin/measure-batch-execute-cost.js --reps 7 --ns 1,5,10,25,50
 *   node bin/measure-batch-execute-cost.js --arms send,exec-cheap --json out.json
 *
 * EXIT: 0 the run completed and every control held, 1 a control failed, 2 cannot run.
 *
 *********************************************************************/
'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
function argVal(name, dflt) {
    const i = process.argv.indexOf('--' + name);
    return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : dflt;
}

const REPS     = parseInt(argVal('reps', '5'), 10);
const NS       = argVal('ns', '1,5,10,25,50').split(',').map(s => parseInt(s.trim(), 10));
const ARMS     = argVal('arms',
    'send,send-tx,exec-cheap,exec-state,exec-worst,deploy,deploy-ctor,deploy-big,deploy-worst')
    .split(',').map(s => s.trim());
// How many state keys `exec-state` writes per execution. Small enough that the
// execution SUCCEEDS (a resource clamp rolls state back and would measure nothing),
// large enough that the contract_state write path is really exercised.
const STATE_KEYS = parseInt(argVal('state-keys', '25'), 10);
// Target byte length of the `deploy-big` contract. Under MAX_CODE_SIZE (65536) with
// room for the generator's own framing.
const DEPLOY_BIG_BYTES = parseInt(argVal('deploy-big-bytes', '65000'), 10);

// What SHAPE each arm puts on a block, and which ACTION its rows carry. The shape
// is not cosmetic: DEPLOY cannot be batched at all (see the header), so an arm that
// claimed to be a BATCH of DEPLOYs would measure one rejection, not N deployments.
const ARM_SPEC = {
    'send':        { shape: 'batch', action: 'SEND'    },
    'send-tx':     { shape: 'tx',    action: 'SEND'    },
    'exec-cheap':  { shape: 'batch', action: 'EXECUTE' },
    'exec-state':  { shape: 'batch', action: 'EXECUTE' },
    'exec-worst':  { shape: 'batch', action: 'EXECUTE' },
    'deploy':      { shape: 'tx',    action: 'DEPLOY'  },
    'deploy-ctor': { shape: 'tx',    action: 'DEPLOY'  },
    'deploy-big':  { shape: 'tx',    action: 'DEPLOY'  },
    'deploy-worst':{ shape: 'tx',    action: 'DEPLOY'  },
};

// The baseline each arm's ratio is formed against: same shape, no VM.
function baselineFor(arm) { return ARM_SPEC[arm].shape === 'batch' ? 'send' : 'send-tx'; }
const JSON_OUT = argVal('json', '');

// ---------------------------------------------------------------------------
// Corpus constants
// ---------------------------------------------------------------------------

// Valid regtest P2PKH addresses, reused from the integration scenarios so the
// corpus cannot fail on an address-format check that has nothing to do with cost.
const ACTOR      = 'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD';
const GAS_FUNDER = 'mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ';
const SEND_DEST  = GAS_FUNDER;

const T0 = 1700000000;   // corpus block time base; +600 per block, like a real chain

// The gas tick is issued by the canonical regtest GAS address and is fee-exempt
// (gasBootstrap in actions/issue.js), so the preamble funds itself. MAX_MINT is set
// to the whole supply because exec-worst burns the gas ceiling on EVERY execution
// and a run of a few hundred of them is a real balance.
const GAS_ISSUE = 'ISSUE|0|XCHAIN|21000000|21000000|8|batch cost measurement';
const GAS_MINT  = 'MINT|0|XCHAIN|5000000';

// `noop` is the cheapest thing a contract can do: no state read, no state write,
// no emission. `burn` spins on integer arithmetic until the metering clamp stops
// it, which is the ceiling an attacker can buy for one sub-command's wire bytes.
// One contract carries both methods so both arms resolve the same contract row and
// differ ONLY in the method the VM runs.
// `fill` keys its writes off the caller-supplied input param so two executions in
// the same block write DIFFERENT keys, which is the honest shape: N executions
// overwriting one key would let the DB collapse work an attacker would not.
const BENCH_CONTRACT = [
    'module.exports = {',
    '    noop: function() { return 1; },',
    '    burn: function() {',
    '        var s = 0;',
    '        for (var i = 0; i < 100000000; i++) { s = s + i; }',
    '        return s;',
    '    },',
    '    fill: function() {',
    '        var tag = xchain.getInputParam(0) || "x";',
    '        for (var i = 0; i < ' + STATE_KEYS + '; i++) {',
    '            xchain.state.set(tag + "-" + i, "0123456789");',
    '        }',
    '        return 1;',
    '    }',
    '};'
].join('\n');

const b64 = s => Buffer.from(s, 'utf8').toString('base64');

// Wire GAS_LIMIT for the DEPLOY arms. Must clear the deployment charge, which is
// VM_DEPLOY_BASE (100000) plus VM_DEPLOY_PER_BYTE (10) x code bytes, and must stay
// at or under the VM's gas ceiling. A deploy-big at ~60000 bytes charges ~700000.
const DEPLOY_GAS_LIMIT = 900000;

// Must match the gasCeiling the indexer configures for the VM in src/actions.js.
// Read back off the live instance at run time rather than trusted from here; this
// is only the fallback for the report line.
const EXPECTED_GAS_CEILING = 1000000;

// ---------------------------------------------------------------------------
// Statistics. Deliberately tiny and explicit: nothing here should be a black box
// when the output becomes a consensus constant.
// ---------------------------------------------------------------------------
function median(xs) {
    const a = xs.slice().sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function stdev(xs) {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

// Ordinary least squares of y against x. Returns slope, intercept and r2. The
// slope is the per-sub-command cost; the intercept is the fixed per-block cost.
function fit(points) {
    const n  = points.length;
    const mx = mean(points.map(p => p.x));
    const my = mean(points.map(p => p.y));
    let sxy = 0, sxx = 0;
    for (const p of points) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) * (p.x - mx); }
    const slope     = sxx === 0 ? 0 : sxy / sxx;
    const intercept = my - slope * mx;
    let ssRes = 0, ssTot = 0;
    for (const p of points) {
        const pred = intercept + slope * p.x;
        ssRes += (p.y - pred) * (p.y - pred);
        ssTot += (p.y - my) * (p.y - my);
    }
    return { slope, intercept, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}

// ---------------------------------------------------------------------------
// Harness plumbing (the integration tier's, so this tool cannot drift from the
// vehicle the rest of the repo already trusts)
// ---------------------------------------------------------------------------
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

let db, DecoderSeeder, launcher, collapseOutputFanout;
try {
    require('xchain-vm');
} catch (e) {
    console.error('measure-batch-execute-cost: require(\'xchain-vm\') FAILED, so every EXECUTE');
    console.error('  would be refused as "executor unavailable" and the run would report a');
    console.error('  weight of roughly 1 for VM work. isolated-vm does not build on macOS;');
    console.error('  run this on Linux/Node 22. Underlying error: ' + (e && e.message));
    process.exit(2);
}
try {
    db                   = require('../test/integration/setup/db-connection');
    DecoderSeeder        = require('../test/integration/setup/decoder-seeder');
    launcher             = require('../test/integration/setup/indexer-launcher');
    collapseOutputFanout = require('../src/output_fanout.js').collapseOutputFanout;
} catch (e) {
    console.error('measure-batch-execute-cost: cannot load the integration harness: ' + (e && e.message));
    process.exit(2);
}

// ---------------------------------------------------------------------------
// ONE timed block. Mirrors XChainIndexer.start()'s inner block body; see FIDELITY
// in the header for exactly what is kept and what is left out and why.
// ---------------------------------------------------------------------------
async function runBlock(indexer, blockIndex) {
    let blockTransactions = await indexer.decoderDb.getDecoderBlockData(blockIndex);
    const fanoutFixActive = await indexer.protocolChanges.isEnabled('FIX_OUTPUT_FANOUT', blockIndex);
    blockTransactions = collapseOutputFanout(blockTransactions, fanoutFixActive, m => indexer.util.logError(m));
    const blockTime = await indexer.decoderDb.getBlockTime(blockIndex);

    // The clock starts AFTER the decoder reads, so the figure is indexer work and
    // not the cost of fetching a corpus a real node already has in hand.
    const t0 = process.hrtime.bigint();

    await indexer.indexerDb.beginTransaction();
    indexer.indexerDb.blockIndex = blockIndex;
    indexer.indexerDb._smtTouched     = null;   // SPV state commitment inactive on this corpus
    indexer.indexerDb._stagedHubPushes = [];    // PRICE hub-push buffer; nothing on this corpus fills it
    try {
        if (indexer.actions.vm) indexer.actions.vm.beginBlock();
        for (const tx of blockTransactions)
            await indexer.actions.processTransaction(tx);
        await indexer.util.processExpirations(indexer.actions, indexer.indexerDb, blockIndex, blockTime);
        await indexer.util.processCancellations(indexer.actions, indexer.indexerDb, blockIndex, blockTime);
        if (indexer.actions.vm) indexer.actions.vm.endBlock();
        await indexer.indexerDb.createBlock(blockIndex, blockTime);
        await indexer.util.processMarketUpdates(indexer.indexerDb, blockIndex, blockTime);
        await indexer.indexerDb.sanityCheck(blockIndex);
        await indexer.indexerDb.commitTransaction();
    } catch (e) {
        await indexer.indexerDb.rollbackTransaction();
        throw e;
    }

    return Number(process.hrtime.bigint() - t0) / 1e6;
}

// ---------------------------------------------------------------------------
// Corpus construction
// ---------------------------------------------------------------------------
// `tag` is the sub-command's POSITION in its block, and deliberately not something
// block-unique. Distinct keys WITHIN a block is the property that matters (N
// executions must not collapse onto one row), while keys that repeat ACROSS blocks
// keep the contract under the VM's maxStateKeys limit. A run that made every key
// unique exhausted that limit part-way through and the later executions failed,
// which the V3 control caught.
function subCommand(arm, contractIndex, tag) {
    if (arm === 'send' || arm === 'send-tx') return 'SEND|0|XCHAIN|1|' + SEND_DEST + '|';
    if (arm === 'exec-cheap') return 'EXECUTE|0|' + contractIndex + '|noop';
    if (arm === 'exec-worst') return 'EXECUTE|0|' + contractIndex + '|burn';
    if (arm === 'exec-state') return 'EXECUTE|0|' + contractIndex + '|fill|' + tag;
    throw new Error('unknown arm: ' + arm);
}

// Every deployed contract must be BYTE-DISTINCT. The VM caches compilation per
// block by code, so N identical deployments in one block would share one compile
// and report a per-deployment cost the fleet never pays for real traffic.
function deployCode(arm, tag) {
    const uniq = '// unique ' + tag + '\n';
    if (arm === 'deploy-ctor')
        return uniq + 'module.exports = {\n' +
               '    initialize: function() { xchain.state.set("init", xchain.getInputParam(0) || "y"); },\n' +
               '    read: function() { return 1; }\n};';
    if (arm === 'deploy-worst')
        // Max-size code AND a constructor that spins to the resource clamp: the two
        // cost terms a DEPLOY can carry, stacked, which is the shape an attacker
        // picks. The deploy is REJECTED at the clamp, but the block loop has already
        // paid for the lint, the validate, the compile and the burn, and that paid
        // work is what the budget bounds.
        return padToSize(uniq + 'module.exports = {\n' +
               '    initialize: function() { var s = 0; for (var i = 0; i < 100000000; i++) { s = s + i; } return s; }') +
               '\n};';
    let src = uniq + 'module.exports = {\n    read: function() { return 1; }';
    if (arm === 'deploy-big') src = padToSize(src);
    return src + '\n};';
}

// Pad an unterminated `module.exports = { ... ` body out to DEPLOY_BIG_BYTES with
// REAL methods, not a giant comment: the cost of code size is parse plus validate
// plus compile of CODE, and a comment is the one thing a parser skips cheaply.
// Padding with comment bytes would measure the byte length and nothing else.
function padToSize(src) {
    let i = 0;
    while (src.length < DEPLOY_BIG_BYTES) {
        src += ',\n    m' + i + ': function() { var a' + i + ' = ' + i + '; return a' + i + ' + 1; }';
        i++;
    }
    return src;
}

// The transactions ONE measured block carries, for this arm at this N.
function blockTxs(arm, n, contractIndex, blockIndex) {
    const spec = ARM_SPEC[arm];
    if (spec.shape === 'batch') {
        const cmds = [];
        for (let i = 0; i < n; i++) cmds.push(subCommand(arm, contractIndex, 'c' + i));
        return [{ source: ACTOR, data: 'BATCH|0|' + cmds.join(';') }];
    }
    const txs = [];
    for (let i = 0; i < n; i++) {
        if (spec.action === 'SEND') {
            txs.push({ source: ACTOR, data: subCommand(arm, contractIndex, 'c' + i) });
        } else {
            // A DEPLOY runs `initialize` only when CONSTRUCTOR_PARAMS is non-empty,
            // so the two constructor arms must carry one and the others must not.
            const ctorParams = (arm === 'deploy-ctor' || arm === 'deploy-worst') ? 'init' : '';
            txs.push({ source: ACTOR, data: 'DEPLOY|0|' +
                b64(deployCode(arm, 'b' + blockIndex + 'c' + i)) + '|' + DEPLOY_GAS_LIMIT + '|' + ctorParams });
        }
    }
    return txs;
}

// ---------------------------------------------------------------------------
// Verification (the V1-V4 controls in the header)
// ---------------------------------------------------------------------------
async function actionCount(blockIndex, actionName) {
    const rows = await db.indexerQuery(
        `SELECT COUNT(*) AS c FROM actions a
         JOIN index_actions ia ON ia.id = a.action_id
         WHERE a.block_index = ? AND ia.action = ?`, [blockIndex, actionName]);
    return Number(rows[0].c);
}

async function verifyCell(cell, gasCeiling) {
    const { arm, n, blockIndex } = cell;
    const problems = [];

    if (ARM_SPEC[arm].action === 'DEPLOY') {
        const acts = await actionCount(blockIndex, 'DEPLOY');
        if (acts !== n) problems.push(`V1: expected ${n} DEPLOY action rows, found ${acts}`);
        const rows = await db.indexerQuery(
            `SELECT s.status AS status, COUNT(*) AS c FROM contracts c
             LEFT JOIN index_statuses s ON s.id = c.status_id
             WHERE c.block_index = ? GROUP BY s.status`, [blockIndex]);
        cell.statuses = rows.map(r => r.status + '=' + r.c).join(', ') || 'none';

        // Every DEPLOY writes a contract_executions row carrying the deployment
        // charge plus whatever its constructor burned, whether or not the deploy is
        // accepted. That row, not the contracts row, is the proof the VM ran: a
        // deploy whose constructor fails writes NO contracts row at all.
        const ex = await db.indexerQuery(
            `SELECT COUNT(*) AS c, MIN(gas_used) AS mn, MAX(gas_used) AS mx
             FROM contract_executions WHERE block_index = ?`, [blockIndex]);
        const exCount = Number(ex[0].c);
        cell.deployGas = exCount ? [Number(ex[0].mn), Number(ex[0].mx)] : null;
        if (exCount !== n)
            problems.push(`V5: expected ${n} contract_executions rows for the deployments, found ${exCount}`);

        if (arm === 'deploy-worst') {
            // The burn constructor MUST have reached the resource clamp, and the
            // clamp charges the full gas ceiling on top of the deployment charge.
            // Anything that refuses the code before it compiles (a syntax error, a
            // size or lint refusal) means the block loop never did the work this arm
            // claims to measure, and the cell times as suspiciously cheap. That exact
            // false green happened once: a generator bug left the padded contract
            // unterminated, every deploy died on "Unexpected end of input", and the
            // arm reported LESS per deployment than a plain small DEPLOY.
            if (exCount && Number(ex[0].mn) < gasCeiling)
                problems.push(`V5: deploy-worst gas_used ranged ${ex[0].mn}..${ex[0].mx}, expected every ` +
                              `deployment to carry the deployment charge PLUS the full ceiling ` +
                              `${gasCeiling}; the burn constructor did not reach the clamp`);
            if (rows.some(r => r.status === 'valid'))
                problems.push(`V5: deploy-worst produced VALID contracts (statuses: ${cell.statuses}); ` +
                              `a constructor that reached the clamp rejects its deploy`);
            return problems;
        }
        const valid = rows.filter(r => r.status === 'valid').reduce((a, r) => a + Number(r.c), 0);
        if (valid !== n)
            problems.push(`V5: expected ${n} valid contracts, found ${valid} ` +
                          `(statuses: ${cell.statuses})`);
        if (arm === 'deploy-ctor') {
            // The constructor is the point of this arm; a deploy whose initialize
            // never ran is the same measurement as the plain `deploy` arm.
            const st = await db.indexerQuery(
                `SELECT COUNT(*) AS c FROM contract_state WHERE block_index = ?`, [blockIndex]);
            if (Number(st[0].c) !== n)
                problems.push(`V5: expected ${n} constructor state rows, found ${st[0].c}; ` +
                              `initialize did not run`);
        }
        return problems;
    }

    if (ARM_SPEC[arm].action === 'SEND') {
        const acts = await actionCount(blockIndex, 'SEND');
        if (acts !== n) problems.push(`V1: expected ${n} SEND action rows, found ${acts}`);
        const rows = await db.indexerQuery(
            `SELECT s.status AS status, COUNT(*) AS c FROM sends x
             LEFT JOIN index_statuses s ON s.id = x.status_id
             JOIN actions a ON a.action_index = x.action_index
             WHERE a.block_index = ? GROUP BY s.status`, [blockIndex]);
        const valid = rows.filter(r => r.status === 'valid').reduce((a, r) => a + Number(r.c), 0);
        if (valid !== n)
            problems.push(`V4: expected ${n} valid sends, found ${valid} ` +
                          `(statuses: ${rows.map(r => r.status + '=' + r.c).join(', ') || 'none'})`);
        return problems;
    }

    const acts = await actionCount(blockIndex, 'EXECUTE');
    if (acts !== n) problems.push(`V1: expected ${n} EXECUTE action rows, found ${acts}`);

    const rows = await db.indexerQuery(
        `SELECT s.status AS status, COUNT(*) AS c, MIN(e.gas_used) AS mn, MAX(e.gas_used) AS mx
         FROM contract_executions e
         LEFT JOIN index_statuses s ON s.id = e.status_id
         WHERE e.block_index = ? GROUP BY s.status`, [blockIndex]);
    const total = rows.reduce((a, r) => a + Number(r.c), 0);
    if (total !== n) problems.push(`V2: expected ${n} contract_executions rows, found ${total}`);

    const minGas = rows.length ? Math.min(...rows.map(r => Number(r.mn))) : 0;
    const maxGas = rows.length ? Math.max(...rows.map(r => Number(r.mx))) : 0;

    if (arm === 'exec-cheap' || arm === 'exec-state') {
        const valid = rows.filter(r => r.status === 'valid').reduce((a, r) => a + Number(r.c), 0);
        if (valid !== n)
            problems.push(`V3: expected ${n} valid executions, found ${valid} ` +
                          `(statuses: ${rows.map(r => r.status + '=' + r.c).join(', ') || 'none'})`);
        if (minGas <= 0) problems.push(`V3: an execution reported gas_used=${minGas}; the VM did not run`);
    }
    if (arm === 'exec-state') {
        // The committed state rows are the whole point of this arm: a clamped or
        // rolled-back execution writes none and would time as a cheap EXECUTE.
        const st = await db.indexerQuery(
            `SELECT COUNT(*) AS c FROM contract_state WHERE block_index = ?`, [blockIndex]);
        const got  = Number(st[0].c);
        const want = n * STATE_KEYS;
        if (got !== want)
            problems.push(`V3: expected ${want} contract_state rows (${n} x ${STATE_KEYS}), found ${got}`);
    }
    if (arm === 'exec-worst') {
        if (minGas !== gasCeiling)
            problems.push(`V3: exec-worst gas_used ranged ${minGas}..${maxGas}, expected every ` +
                          `execution clamped at the ceiling ${gasCeiling}; the burn did not reach it`);
    }
    return problems;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    if (!process.env.XCHAIN_DECODER_SQL_PATH) {
        console.error('measure-batch-execute-cost: XCHAIN_DECODER_SQL_PATH is unset; the decoder');
        console.error('  schema cannot be created and the corpus would have nowhere to live.');
        process.exit(2);
    }
    for (const arm of ARMS)
        if (!ARM_SPEC[arm]) {
            console.error('measure-batch-execute-cost: unknown arm "' + arm + '"');
            process.exit(2);
        }

    console.log('measure-batch-execute-cost: node ' + process.version + ' on ' +
                process.platform + '/' + process.arch);
    console.log('  arms=' + ARMS.join(',') + '  ns=' + NS.join(',') + '  reps=' + REPS);

    await db.createDatabases();
    await db.createDecoderSchema();
    const seeder = new DecoderSeeder(db.decoderQuery);

    // --- preamble: gas bootstrap, then the bench contract -------------------
    let block = 100;
    await seeder.seedBlock(block, T0 + block * 600, [
        { source: GAS_FUNDER, data: GAS_ISSUE },
        { source: ACTOR,      data: GAS_MINT  },
    ]);
    const gasBlock = block++;
    await seeder.seedBlock(block, T0 + block * 600, [
        { source: ACTOR, data: 'DEPLOY|0|' + b64(BENCH_CONTRACT) + '|300000|' },
    ]);
    const deployBlock = block++;

    const indexer = await launcher.initIndexer();
    const gasCeiling = (indexer.actions.vm && indexer.actions.vm._gasCeiling) || EXPECTED_GAS_CEILING;

    if (!indexer.actions.vm) {
        console.error('measure-batch-execute-cost: the indexer built NO vm instance, so EXECUTE');
        console.error('  would be refused without running contract code. Refusing to report a number.');
        process.exit(2);
    }

    await runBlock(indexer, gasBlock);
    await runBlock(indexer, deployBlock);

    const contractRows = await db.indexerQuery(
        `SELECT c.action_index AS ai, s.status AS status FROM contracts c
         LEFT JOIN index_statuses s ON s.id = c.status_id WHERE c.block_index = ?`, [deployBlock]);
    if (!contractRows.length || contractRows[0].status !== 'valid') {
        console.error('measure-batch-execute-cost: the bench contract did not deploy (status=' +
                      (contractRows.length ? contractRows[0].status : 'no row') + ').');
        console.error('  Every EXECUTE would then fail before reaching the VM and the ratio would be a lie.');
        process.exit(1);
    }
    const contractIndex = Number(contractRows[0].ai);
    console.log('  bench contract deployed at action_index ' + contractIndex +
                ', gas ceiling ' + gasCeiling);

    // --- seed the measured blocks ------------------------------------------
    // Arms are interleaved WITHIN a repetition so a load spike on a shared box
    // hits every arm rather than skewing one of them.
    const cells = [];
    for (let rep = 0; rep < REPS; rep++) {
        for (const n of NS) {
            for (const arm of ARMS) {
                await seeder.seedBlock(block, T0 + block * 600,
                    blockTxs(arm, n, contractIndex, block));
                cells.push({ arm, n, rep, blockIndex: block });
                block++;
            }
        }
        // The empty-block control: the fixed per-block cost, measured not assumed.
        await seeder.seedBlock(block, T0 + block * 600, []);
        cells.push({ arm: 'empty', n: 0, rep, blockIndex: block });
        block++;
    }

    // --- drive ---------------------------------------------------------------
    console.log('  driving ' + cells.length + ' measured blocks');
    for (const cell of cells) {
        cell.ms = await runBlock(indexer, cell.blockIndex);
        process.stdout.write('.');
    }
    console.log('');

    // --- verify --------------------------------------------------------------
    let failures = 0;
    for (const cell of cells) {
        if (cell.arm === 'empty') continue;
        const problems = await verifyCell(cell, gasCeiling);
        if (problems.length) {
            failures++;
            console.error('CONTROL FAILED  block ' + cell.blockIndex + '  ' + cell.arm + ' N=' + cell.n);
            for (const p of problems) console.error('    ' + p);
        }
    }

    // --- report --------------------------------------------------------------
    const report = { meta: {}, raw: cells, perCell: {}, fits: {}, ratios: {} };
    report.meta = {
        node: process.version, platform: process.platform + '/' + process.arch,
        arms: ARMS, ns: NS, reps: REPS, gasCeiling, contractIndex, stateKeys: STATE_KEYS,
        deployBigBytes: deployCode('deploy-big', 'sizing').length,
        deploySmallBytes: deployCode('deploy', 'sizing').length,
        coin: process.env.INDEXER_COIN, network: process.env.INDEXER_NETWORK,
        takenAt: new Date().toISOString(),
    };

    console.log('');
    console.log('RAW TIMINGS (ms per block, one BATCH of N sub-commands per block)');
    console.log('arm         N     ' + Array.from({ length: REPS }, (_, i) => 'rep' + i).join('      '));
    for (const arm of ARMS.concat(['empty'])) {
        for (const n of (arm === 'empty' ? [0] : NS)) {
            const runs = cells.filter(c => c.arm === arm && c.n === n).map(c => c.ms);
            if (!runs.length) continue;
            report.perCell[arm + ':' + n] = {
                runs, median: median(runs), mean: mean(runs), stdev: stdev(runs),
                cv: mean(runs) ? stdev(runs) / mean(runs) : 0,
            };
            console.log(arm.padEnd(12) + String(n).padStart(3) + '   ' +
                        runs.map(r => r.toFixed(1).padStart(8)).join(' '));
        }
    }

    console.log('');
    console.log('PER-CELL SUMMARY (median ms, coefficient of variation across reps)');
    for (const key of Object.keys(report.perCell)) {
        const s = report.perCell[key];
        console.log('  ' + key.padEnd(16) + 'median=' + s.median.toFixed(1).padStart(9) +
                    '  cv=' + (s.cv * 100).toFixed(1) + '%');
    }

    console.log('');
    console.log('PER-SUB-COMMAND COST (median block ms minus the empty-block median, over N).');
    console.log('This is the shape check: a flat column is LINEAR in N, a rising column is worse.');
    const emptyMedian = report.perCell['empty:0'] ? report.perCell['empty:0'].median : 0;
    report.meta.emptyBlockMedianMs = emptyMedian;
    for (const arm of ARMS) {
        const cols = NS.map(n => {
            const s = report.perCell[arm + ':' + n];
            return s ? ((s.median - emptyMedian) / n) : null;
        });
        report.perCell[arm + ':marginal'] = cols;
        console.log('  ' + arm.padEnd(12) +
                    NS.map((n, i) => 'N=' + n + ':' + (cols[i] === null ? '-' : cols[i].toFixed(3))).join('  '));
    }

    console.log('');
    console.log('LEAST-SQUARES FIT of block ms against N (slope = ms per sub-command)');
    for (const arm of ARMS) {
        const pts = cells.filter(c => c.arm === arm).map(c => ({ x: c.n, y: c.ms }));
        const f = fit(pts);
        report.fits[arm] = f;
        console.log('  ' + arm.padEnd(12) + 'slope=' + f.slope.toFixed(4) + ' ms/sub-command' +
                    '   intercept=' + f.intercept.toFixed(2) + ' ms' +
                    '   r2=' + f.r2.toFixed(4));
    }
    if (report.fits['send'] && Math.abs(report.fits['send'].intercept - emptyMedian) >
        Math.max(5, emptyMedian * 0.5))
        console.log('  NOTE: the send intercept is far from the empty-block median (' +
                    emptyMedian.toFixed(1) + ' ms). Treat the fit as suspect and re-run.');

    // Gas beside wall time, because the spec's central claim is that gas is the WRONG
    // grounding for this budget. Printing both makes that claim checkable rather than
    // asserted: where ms-per-gas differs between arms, gas is not tracking indexer work.
    console.log('');
    console.log('GAS OBSERVED vs WALL TIME (the spec rejects gas as the grounding; this is the check)');
    for (const arm of ARMS) {
        const g = cells.filter(c => c.arm === arm && c.deployGas).map(c => c.deployGas[0]);
        if (!g.length) continue;
        const gm = median(g);
        const slope = report.fits[arm] ? report.fits[arm].slope : 0;
        console.log('  ' + arm.padEnd(12) + 'gas/deployment=' + String(gm).padStart(9) +
                    '   ms/deployment=' + slope.toFixed(1).padStart(7) +
                    '   ms per 1M gas=' + (gm ? (slope / gm * 1e6).toFixed(0) : '-').padStart(6));
    }

    console.log('');
    console.log('RATIO: cost expressed in ORDINARY sub-commands (minimal SENDs).');
    console.log('Each arm is divided by the baseline of its own SHAPE, never across shapes.');
    for (const arm of ARMS) {
        if (arm === 'send' || arm === 'send-tx') continue;
        const base = baselineFor(arm);
        if (!report.fits[base] || report.fits[base].slope <= 0) {
            console.log('  ' + arm.padEnd(12) + 'no ratio: baseline arm "' + base + '" was not measured');
            continue;
        }
        const r = report.fits[arm].slope / report.fits[base].slope;
        report.ratios[arm] = r;
        // Per-repetition ratios, so the spread of the RATIO itself is reported and
        // not just the spread of the two timings it is built from.
        const perRep = [];
        for (let rep = 0; rep < REPS; rep++) {
            const b = fit(cells.filter(c => c.arm === base && c.rep === rep).map(c => ({ x: c.n, y: c.ms })));
            const a = fit(cells.filter(c => c.arm === arm  && c.rep === rep).map(c => ({ x: c.n, y: c.ms })));
            if (b.slope > 0) perRep.push(a.slope / b.slope);
        }
        report.ratios[arm + ':perRep'] = perRep;
        console.log('  ' + arm.padEnd(12) + r.toFixed(1) + 'x a minimal SEND  (vs ' + base + ')');
        if (perRep.length)
            console.log('    per-rep: ' + perRep.map(x => x.toFixed(1)).join(', ') +
                        '   median=' + median(perRep).toFixed(1) +
                        '  min=' + Math.min(...perRep).toFixed(1) +
                        '  max=' + Math.max(...perRep).toFixed(1));
    }
    if (report.fits['send'] && report.fits['send-tx'])
        console.log('  SHAPE CONTROL: send (in a BATCH) ' + report.fits['send'].slope.toFixed(2) +
                    ' ms vs send-tx (separate transactions) ' + report.fits['send-tx'].slope.toFixed(2) +
                    ' ms per sub-command. A large gap here means the two baselines are not' +
                    ' interchangeable and cross-shape comparisons must not be made.');

    console.log('');
    console.log('RECOMMENDATION (input to spec row 2; the operator ratifies, this tool does not)');
    // Each family's bound is its WORST measured arm, not its average: the budget
    // exists to stop a denial of service and the attacker, not the platform, picks
    // the contract. The parity weight is ceil(ratio): the value at which a full
    // batch of that action costs the same block-loop work as a full batch of
    // ordinary sub-commands, which is what makes the budget mean ONE thing.
    const families = {
        'EXECUTE / XEXEC': ARMS.filter(a => a.startsWith('exec-')),
        'DEPLOY':          ARMS.filter(a => a.startsWith('deploy')),
    };
    const admits = w => Math.floor(250 / w);
    for (const [family, arms] of Object.entries(families)) {
        const have = arms.filter(a => report.ratios[a] !== undefined);
        if (!have.length) { console.log('  ' + family + ': not measured.'); continue; }
        const worstArm = have.reduce((a, b) => report.ratios[a] >= report.ratios[b] ? a : b);
        const r = report.ratios[worstArm];
        const parity = Math.ceil(r);
        report.meta['worstArm:' + family] = worstArm;
        report.meta['parityWeight:' + family] = parity;
        console.log('  ' + family + ': worst measured arm is ' + worstArm + ' at ' +
                    r.toFixed(1) + 'x a minimal SEND.');
        console.log('    parity weight = ceil(' + r.toFixed(1) + ') = ' + parity +
                    ', admitting ' + admits(parity) + ' per batch.');
        for (const w of [parity, 10, 25, 50, 100, 250].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b))
            console.log('      weight ' + String(w).padStart(3) + '  admits ' + String(admits(w)).padStart(3) +
                        ' per batch = ' + String((admits(w) * r).toFixed(0)).padStart(5) +
                        ' SEND-equivalents (status quo cap = 250)');
    }
    if (report.ratios['deploy'] !== undefined && report.ratios['deploy-big'] !== undefined) {
        const bigCode = deployCode('deploy-big', 'sizing').length;
        const smallCode = deployCode('deploy', 'sizing').length;
        console.log('  DEPLOY size sensitivity: ' + smallCode + ' bytes costs ' +
                    report.ratios['deploy'].toFixed(1) + 'x, ' + bigCode + ' bytes costs ' +
                    report.ratios['deploy-big'].toFixed(1) + 'x. A flat pair means the cost is a' +
                    ' FIXED isolate/validate overhead and VM_DEPLOY_PER_BYTE does not describe' +
                    ' indexer work; a rising pair means size really is the driver.');
    }
    if (report.ratios['deploy'] !== undefined && report.ratios['deploy-ctor'] !== undefined)
        console.log('  DEPLOY constructor cost: no-constructor ' + report.ratios['deploy'].toFixed(1) +
                    'x vs constructor ' + report.ratios['deploy-ctor'].toFixed(1) + 'x.');

    if (JSON_OUT) {
        fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify(report, null, 2));
        console.log('\n  raw report written to ' + path.resolve(JSON_OUT));
    }

    await launcher.destroyIndexer(indexer);
    await db.closeAll();

    if (failures) {
        console.error('\n' + failures + ' control(s) failed; the numbers above describe work that did');
        console.error('not happen as intended. Do NOT quote them.');
        process.exit(1);
    }
    console.log('\nall controls held.');
    process.exit(0);
}

main().catch(e => {
    console.error('measure-batch-execute-cost: ' + (e && e.stack || e));
    process.exit(2);
});

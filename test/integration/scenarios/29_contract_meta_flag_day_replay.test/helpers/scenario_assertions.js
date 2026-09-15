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
 * Integration: CONTRACT_META_REQUIRED flag day, the REPLAY half of the verdict checks in deploy_contract_meta.test.js.
 *
 * The consensus risk a new deploy verdict carries is not that it rejects the
 * contracts it is meant to reject: it is that it silently moves a verdict the
 * chain already recorded. A node that replays from genesis under the new code
 * must reproduce every PRE-ACTIVATION status and every pre-activation block hash
 * byte for byte, or it forks off its own history.
 *
 * This scenario drives both sides of that boundary on ONE chain:
 *
 *   1. Below the flag day a NAMELESS contract still deploys `valid` and stores
 *      four NULL meta columns, and a contract that happens to carry a conforming
 *      `meta` gets its columns for free (the verdict is gated, the extraction is
 *      not: see actions/deploy.js, where the below-flag-day branch lives).
 *   2. Two INDEPENDENT indexer nodes replaying that pre-activation corpus from
 *      genesis produce byte-identical databases and an identical resolved hash
 *      chain (setup/equivalence.js).
 *   3. Extending the SAME chain past the flag day leaves every pre-activation
 *      block hash and every pre-activation status untouched, while the identical
 *      nameless shape now reads `invalid: CONTRACT_MANIFEST (meta required)`.
 *
 * HOW THE BOUNDARY IS CROSSED, and why this file runs on `testnet`. The rule is
 * block-TIME keyed (protocol_changes.js addChange, resolved through the decoder's
 * block_time). regtest arms it at 0, so on regtest there is no below-flag block to
 * replay at all: the regtest-active half is 16-controller-permissions. testnet
 * arms it at a future instant (1789257600), which is a real block time
 * a decoder row can hold (block_time is BIGINT UNSIGNED on both schemas), so a
 * seeded block above it activates the rule on the same chain that carries the
 * blocks below it. That is strictly stronger than comparing two networks: the
 * pre-activation hashes compared before and after are the SAME rows of the SAME
 * ledger, so "the historic verdict did not move" is asserted directly rather than
 * inferred from a second run. Every other testnet gate is genesis-active (time 0)
 * except ISSUE_INHERITED_MINT_WINDOW and DEPLOY_DEFERRED_ASSEMBLY, which the
 * pre-activation block time is deliberately above, so the two halves differ in
 * exactly one activation: this one.
 *
 * AND THE CLOCK IS MEDIAN TIME PAST. testnet resolves protocol time from MTP over
 * the previous 11 blocks (src/consensus/protocol_time.js; regtest and mainnet read the raw
 * stamp), so ONE future-stamped block arms nothing: the corpus drags the median
 * across the flag day with a short run of blocks, and the first of them carries a
 * nameless deploy that must still read `valid` precisely because its own stamp is
 * above the flag day while the median below it is not. That is the same arithmetic
 * the release re-pin rule applies ("strictly above the tip and the tip's
 * median-time-past at re-pin").
 *
 * Run (disposable MariaDB; bin/run-db-tiers.sh provisions one):
 *   TEST_DB_HOST=127.0.0.1 TEST_DB_PORT=<port> TEST_DB_USER=root TEST_DB_PASS=<pw> \
 *   TEST_DECODER_DB=<db> TEST_INDEXER_DB=<db> TEST_INDEXER_DB_B=<db> \
 *   XCHAIN_DECODER_SQL_PATH=<xchain-decoder/src/sql> \
 *   npx mocha --no-config --no-package --exit \
 *       test/integration/scenarios/29_contract_meta_flag_day_replay.test.js
 ********************************************************************/
'use strict';

const assert = require('assert');
const crypto = require('crypto');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
// One number over a resolved hash chain, so the before/after comparison is readable
// in the run output. The ASSERTION is assertHashChainsEqual, which names the first
// divergent block; this only makes the same fact visible.
const chainDigest = chain => sha(JSON.stringify(chain));

/** One contract row, addressed by the sha256 of its source. */
async function rowFor(queryFn, code) {
    const h = sha(code);
    const rows = await queryFn(
        `SELECT c.action_index, c.code_hash, c.block_index,
                s.status AS status,
                c.meta_name, c.meta_description, c.meta_version, c.meta_json
         FROM contracts c
         LEFT JOIN index_statuses s ON s.id = c.status_id`, []);
    return rows.find(r => r.code_hash === h);
}

function assertNoMetaColumns(row, label) {
    assert.strictEqual(row.meta_name,        null, label + ': meta_name is NULL');
    assert.strictEqual(row.meta_description, null, label + ': meta_description is NULL');
    assert.strictEqual(row.meta_version,     null, label + ': meta_version is NULL');
    assert.strictEqual(row.meta_json,        null, label + ': meta_json is NULL');
}
function restoreEnv(name, value) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

module.exports = { chainDigest, rowFor, assertNoMetaColumns, restoreEnv };

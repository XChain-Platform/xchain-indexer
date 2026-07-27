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
 * test/unit/priceReadPredicate.test.js
 *
 * : the price/oracle mirror barriers waited on EVERY block, so every
 * mainnet tip block burned the full 60s timeout waiting for a mirror it never
 * read. The barrier is now skipped for blocks that provably cannot reach a price
 * read.
 *
 * The property under test is SOUNDNESS, not accuracy. Waiting when we need not
 * costs latency; skipping when the block DOES read a price is a fork. So every
 * uncertain input must resolve to "wait", and every price-mirror read must fail
 * the block closed if the barrier was skipped for it.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const fs   = require('fs');
const path = require('path');

const { getTestConfig }      = require('../fixtures/config');
const Utility                = require('../../src/utility');
const Database               = require('../../src/db');
const XChainIndexer          = require('../../src/XChainIndexer');
const { blockMayReadPrice }  = require('../../src/priceReadPredicate');

const INDEXER_SRC = fs.readFileSync(
    path.resolve(__dirname, '../../src/XChainIndexer.js'), 'utf8');

// Minimal `this` for the barrier decision, in the shape the block loop presents.
// Same prototype-call harness as test/unit/directCallPresence.test.js.
function ctx(opts = {}) {
    return {
        hubDbSync:              opts.noSync ? null : { waitForPriceSyncTime: () => {} },
        priceBarrierBlock:      null,
        priceBarrierSkipped:    false,
        priceBarrierForceBlock: opts.forceBlock !== undefined ? opts.forceBlock : null
    };
}

const evaluate = (self, block, txs) =>
    XChainIndexer.prototype._evaluatePriceBarrier.call(self, block, txs);

function makeDb() {
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = {
        config,
        util,
        priceBarrierBlock:      959864,
        priceBarrierSkipped:    false,
        priceBarrierForceBlock: null
    };
    const db = new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
    // Every read site below must assert BEFORE it queries, so a stub that fails
    // the test if it is ever reached proves the assertion fires first.
    sinon.stub(db, 'doQuery').callsFake(() => {
        throw new Error('doQuery reached: the price-barrier assertion did not fire first');
    });
    return db;
}

describe(' action-scoped price barrier', function () {

    afterEach(() => sinon.restore());

    describe('blockMayReadPrice (soundness of the skip decision)', function () {

        it('a block with no decoder rows cannot reach a transaction-borne price read', function () {
            assert.strictEqual(blockMayReadPrice([]), false);
        });

        it('any transaction at all means wait', function () {
            assert.strictEqual(blockMayReadPrice([{ tx_hash: 'aa' }]), true);
            assert.strictEqual(blockMayReadPrice([{ tx_hash: 'aa' }, { tx_hash: 'bb' }]), true);
        });

        // The unsound direction is the only one that can fork, so anything that is
        // not demonstrably an empty row set has to wait.
        it('resolves every malformed input to "wait" rather than "skip"', function () {
            for (const bad of [null, undefined, 0, '', 'nope', {}, { length: 0 }, new Set()])
                assert.strictEqual(blockMayReadPrice(bad), true,
                    'unexpected skip for ' + JSON.stringify(String(bad)));
        });

    });

    describe('_evaluatePriceBarrier (the block loop\'s decision)', function () {

        it('waits, and records no skip, for a block carrying transactions', function () {
            const self = ctx();
            assert.strictEqual(evaluate(self, 959864, [{ tx_hash: 'aa' }]), true);
            assert.strictEqual(self.priceBarrierSkipped, false);
            assert.strictEqual(self.priceBarrierBlock, 959864);
        });

        it('skips an empty block and records the skip for the read-site assertion', function () {
            const self = ctx();
            assert.strictEqual(evaluate(self, 959864, []), false);
            assert.strictEqual(self.priceBarrierSkipped, true);
            assert.strictEqual(self.priceBarrierBlock, 959864);
        });

        // Without this the escalated retry would skip again, trip the assertion again,
        // and the indexer would spin on the block forever instead of converging.
        it('an escalated block waits even though it is empty', function () {
            const self = ctx({ forceBlock: 959864 });
            assert.strictEqual(evaluate(self, 959864, []), true);
            assert.strictEqual(self.priceBarrierSkipped, false);
        });

        it('the escalation pins one block only, not every block after it', function () {
            const self = ctx({ forceBlock: 959864 });
            assert.strictEqual(evaluate(self, 959865, []), false,
                'a stale force flag must not re-arm the every-block wait this change removes');
            assert.strictEqual(self.priceBarrierSkipped, true);
        });

        // Single-host stacks have no mirror, so the barriers never ran there. Flagging a
        // skip would arm the choke-point assertion against reads that were always fine.
        it('never records a skip on a single-host stack with no mirror', function () {
            const self = ctx({ noSync: true });
            assert.strictEqual(evaluate(self, 959864, []), false);
            assert.strictEqual(self.priceBarrierSkipped, false,
                'a node with no hubDbSync must never fence its own price reads');
        });

        it('carries the predicate\'s malformed-input soundness into the loop', function () {
            const self = ctx();
            assert.strictEqual(evaluate(self, 959864, null), true);
            assert.strictEqual(self.priceBarrierSkipped, false);
        });

    });

    // The flag lifecycle lives inline in the block loop (start() is not importable in
    // isolation, same constraint reorg-catchup-cursor.test.js documents), so it is pinned
    // as source guards. Both clear points are load-bearing in opposite directions.
    describe('skip-flag lifecycle in the block loop', function () {

        it('a committed block clears the skip flag and retires its own escalation', function () {
            assert.ok(/this\.priceBarrierSkipped = false;[\s\S]{0,400}?if\(this\.priceBarrierForceBlock === blockToParse\)\s*\n\s*this\.priceBarrierForceBlock = null;/
                .test(INDEXER_SRC),
                'after commit the flag must clear (or the assertion would fence post-block ' +
                'reads) and the escalation must retire (or the block loop would keep waiting ' +
                'on every block, which is the cost this change removes)');
        });

        it('a rolled-back block clears the skip flag but KEEPS its escalation', function () {
            const rollback = INDEXER_SRC.slice(INDEXER_SRC.indexOf('await this.indexerDb.rollbackTransaction();'));
            const clear    = rollback.indexOf('this.priceBarrierSkipped = false;');
            assert.ok(clear > 0 && clear < 800,
                'the rollback path must clear the skip flag for the block it just abandoned');
            assert.ok(!/priceBarrierForceBlock = null/.test(rollback.slice(0, 800)),
                'the rollback path must NOT clear the escalation: when this rollback IS the ' +
                'price-barrier defer, that flag is the only thing making the retry wait');
        });

    });

    describe('db._assertPriceBarrierNotSkipped (fail-closed backstop)', function () {

        it('is inert outside block processing, so API reads are never fenced', function () {
            const db = makeDb();
            db.indexer.priceBarrierSkipped = true;
            // No txEpochStore context: this is an api.js fee quote or a healthcheck,
            // free to read whatever the mirror currently holds.
            assert.doesNotThrow(() => db._assertPriceBarrierNotSkipped('test'));
            assert.strictEqual(db.indexer.priceBarrierForceBlock, null);
        });

        it('is inert during a block that DID take the barrier', function () {
            const db = makeDb();
            db.indexer.priceBarrierSkipped = false;
            db.runInTxEpoch(0, () => {
                assert.doesNotThrow(() => db._assertPriceBarrierNotSkipped('test'));
            });
            assert.strictEqual(db.indexer.priceBarrierForceBlock, null);
        });

        it('throws when a skipped-barrier block reads the mirror, and escalates that block', function () {
            const db = makeDb();
            db.indexer.priceBarrierSkipped = true;
            db.runInTxEpoch(0, () => {
                assert.throws(() => db._assertPriceBarrierNotSkipped('test'), /price barrier skipped/);
            });
            // The retry must take the barrier, or the block would skip again and loop.
            assert.strictEqual(db.indexer.priceBarrierForceBlock, 959864);
        });

    });

    // Sweep the siblings: a guard on four of the five readers is a fork on the fifth.
    describe('every price-mirror read is guarded', function () {

        const READS = [
            ['getOracleDataForVM',        (db) => db.getOracleDataForVM(959864, 1785174804, 1800)],
            ['getLatestPrice',            (db) => db.getLatestPrice('BTC/USD', 959864, {})],
            ['getOraclePrice',            (db) => db.getOraclePrice('addr', 'BTC', 'XCHAIN', 'USD', 1785174804)],
            ['getOraclePricesInTimeRange',(db) => db.getOraclePricesInTimeRange('addr', 'BTC', 'XCHAIN', 'USD', 0, 1785174804)],
            ['getPricesInTimeRange',      (db) => db.getPricesInTimeRange('BTC/USD', 0, 1785174804)],
        ];

        for (const [name, call] of READS) {
            it(name + ' fails the block closed instead of reading an uncovered mirror', async function () {
                const db = makeDb();
                db.indexer.priceBarrierSkipped = true;
                await db.runInTxEpoch(0, async () => {
                    await assert.rejects(async () => call(db), /price barrier skipped/);
                });
                assert.strictEqual(db.indexer.priceBarrierForceBlock, 959864);
            });
        }

    });

});

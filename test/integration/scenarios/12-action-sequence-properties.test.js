'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Phase 1b property suite: randomized valid action sequences preserve
 * every whole-ledger invariant after EVERY block.
 *
 * A seeded model generates mostly-valid ISSUE/MINT/SEND/DESTROY sequences
 * (with deliberate invalid attempts mixed in — over-mints, overspends),
 * drives them through the REAL indexer block by block, and asserts the
 * state-invariants sweep (conservation, supply>=0, escrow>=0, no negative
 * balances) after each block. The model only steers generation toward
 * validity — correctness is judged solely by the DB-level invariants, so
 * a model/indexer disagreement (e.g. an action the model thought valid
 * being rejected, or fees the model didn't track) cannot mask a real
 * conservation break.
 *
 * Repro: every failure prints `seed=N block=B` plus the full action log.
 * Tune breadth via env: PROPERTY_RUNS (default 5), PROPERTY_BLOCKS (10).
 */

const assert = require('assert');
const fc = require('fast-check');
const { decoderQuery, indexerQuery, createDatabases, createDecoderSchema,
        resetDecoderDb, resetIndexerDb, closeAll } = require('../setup/db-connection');
const DecoderSeeder = require('../setup/decoder-seeder');
const { initIndexer, processBlocks, destroyIndexer } = require('../setup/indexer-launcher');
const { seedGas } = require('../setup/gas-seeder');
const { assertStateInvariants } = require('../setup/state-invariants');

const RUNS   = parseInt(process.env.PROPERTY_RUNS   || '5', 10);
const BLOCKS = parseInt(process.env.PROPERTY_BLOCKS || '10', 10);

// Valid regtest P2PKH actors (same pool the other scenarios use)
const ACTORS = [
    'msK1rsgNVFPM4cR3X5rngczTKa6EtT4WKD',
    'mjifPngDYQ6HHPNQdGk1kQuFkJWEiQksQp',
    'mwGujTXFXMLN2YXqo4mQK4DcKy31DUcwoi',
];

// Deterministic PRNG (mulberry32) so a failing run replays from its seed.
function prng(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Generation model: integer amounts, decimals=0 ticks. Tracks supply and
// per-address balances WELL ENOUGH to keep most actions valid; it is not
// (and must not need to be) an exact ledger.
class Model {
    constructor(rand) {
        this.rand = rand;
        this.nextTick = 1;
        this.tokens = {};   // tick → { maxSupply, maxMint, supply }
        this.balances = {}; // addr → tick → int
    }
    pick(arr) { return arr[Math.floor(this.rand() * arr.length)]; }
    int(lo, hi) { return lo + Math.floor(this.rand() * (hi - lo + 1)); }
    credit(addr, tick, n) {
        this.balances[addr] = this.balances[addr] || {};
        this.balances[addr][tick] = (this.balances[addr][tick] || 0) + n;
    }
    holders(tick) {
        return ACTORS.filter(a => (this.balances[a] && this.balances[a][tick] || 0) > 0);
    }

    // Produce one action { source, data, note } — ~85% intended-valid,
    // ~15% deliberately invalid (must be rejected without breaking invariants).
    nextAction() {
        const ticks = Object.keys(this.tokens);
        const roll = this.rand();

        if (ticks.length === 0 || roll < 0.18) {                       // ISSUE
            const tick = 'PROP' + (this.nextTick++);
            const maxSupply = this.int(500, 5000);
            const maxMint = this.int(50, 500);
            this.tokens[tick] = { maxSupply, maxMint, supply: 0 };
            return { source: this.pick(ACTORS),
                     data: `ISSUE|0|${tick}|${maxSupply}|${maxMint}|0|prop token`,
                     note: 'ISSUE ' + tick };
        }

        const tick = this.pick(ticks);
        const t = this.tokens[tick];

        if (roll < 0.50) {                                             // MINT
            const headroom = t.maxSupply - t.supply;
            if (headroom <= 0 || this.rand() < 0.15) {
                // deliberate over-mint (or no headroom left) — expect rejection
                return { source: this.pick(ACTORS),
                         data: `MINT|0|${tick}|${t.maxMint}`,
                         note: 'over-MINT ' + tick };
            }
            const amt = Math.min(this.int(1, t.maxMint), headroom);
            const source = this.pick(ACTORS);
            t.supply += amt;
            this.credit(source, tick, amt);
            return { source, data: `MINT|0|${tick}|${amt}`, note: 'MINT ' + tick };
        }

        if (roll < 0.85) {                                             // SEND
            const holders = this.holders(tick);
            if (holders.length === 0 || this.rand() < 0.15) {
                // overspend from a (possibly empty) address — expect rejection
                return { source: this.pick(ACTORS),
                         data: `SEND|0|${tick}|999999|${this.pick(ACTORS)}`,
                         note: 'over-SEND ' + tick };
            }
            const source = this.pick(holders);
            const bal = this.balances[source][tick];
            const amt = this.int(1, bal);
            const dest = this.pick(ACTORS.filter(a => a !== source));
            this.credit(source, tick, -amt);
            this.credit(dest, tick, amt);
            return { source, data: `SEND|0|${tick}|${amt}|${dest}`, note: 'SEND ' + tick };
        }

        // DESTROY
        const holders = this.holders(tick);
        if (holders.length === 0)
            return { source: this.pick(ACTORS),
                     data: `DESTROY|0|${tick}|1`, note: 'no-balance DESTROY ' + tick };
        const source = this.pick(holders);
        const bal = this.balances[source][tick];
        const amt = this.int(1, bal);
        this.credit(source, tick, -amt);
        this.tokens[tick].supply -= amt;
        return { source, data: `DESTROY|0|${tick}|${amt}`, note: 'DESTROY ' + tick };
    }
}

async function runSequence(seed) {
    const rand = prng(seed);
    const model = new Model(rand);
    const log = [];

    await resetDecoderDb();
    await resetIndexerDb();
    const seeder = new DecoderSeeder(decoderQuery);
    const indexer = await initIndexer();
    try {
        // Fee era: every actor needs gas before its first ISSUE (1 XCHAIN each)
        await seedGas(seeder, { addresses: ACTORS, amount: '500' });

        let blockIndex = 100;
        let blockTime = 1700000000;
        for (let b = 0; b < BLOCKS; b++) {
            const txs = [];
            const count = model.int(1, 4);
            for (let i = 0; i < count; i++) {
                const a = model.nextAction();
                txs.push({ source: a.source, data: a.data });
                log.push(`block ${blockIndex}: ${a.note} [${a.data}]`);
            }
            await seeder.seedBlock(blockIndex, blockTime, txs);
            await processBlocks(indexer);
            try {
                await assertStateInvariants(indexerQuery);
            } catch (e) {
                e.message = `seed=${seed} block=${blockIndex}: ${e.message}\nACTION LOG:\n${log.join('\n')}`;
                throw e;
            }
            blockIndex++;
            blockTime += 600;
        }
    } finally {
        await destroyIndexer(indexer);
    }
}

describe('12 Randomized action sequences preserve ledger invariants @tier3', function () {
    this.timeout(0);

    before(async function () {
        await createDatabases();
        await createDecoderSchema();
    });

    after(async function () {
        await closeAll();
    });

    it(`holds every invariant after every block (${RUNS} runs × ${BLOCKS} blocks)`, async function () {
        await fc.assert(
            fc.asyncProperty(fc.noShrink(fc.integer({ min: 1, max: 2 ** 30 })), async (seed) => {
                await runSequence(seed);
                return true;
            }),
            { numRuns: RUNS }
        );
    });

    it('replays a pinned seed (regression anchor for the generator itself)', async function () {
        await runSequence(424242);
    });
});

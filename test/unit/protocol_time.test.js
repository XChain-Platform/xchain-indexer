'use strict';

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
 * Protocol time (median-time-past).
 *
 * The defect these pin: a block's raw timestamp is chosen by whoever mined it
 * and Bitcoin accepts it up to ~2h ahead of network-adjusted time. Reading
 * hub-mirrored data at a future instant forced the indexer's mirror barriers to
 * wait for wall clock, so a confirmed testnet4 transaction took hours to index.
 *
 * The fixture below is REAL testnet4 data, blocks 149798-149809 measured
 * 2026-08-25, every block spaced exactly 1201s apart (the 20-minute
 * minimum-difficulty fingerprint). It is here so the property that makes the
 * fix work - that MTP lands behind wall clock even on the chain that broke us -
 * is asserted against the chain rather than against an invented example.
 *
 *********************************************************************/

const assert = require('assert');
const {
    MEDIAN_TIME_SPAN,
    PROTOCOL_TIME_MTP_NETWORKS,
    isProtocolTimeMtpActive,
    medianTimePast,
    protocolTime,
    stampProtocolTime
} = require('../../src/protocol_time');

// Real testnet4 stamps, oldest first (149798..149809).
const TESTNET4 = [
    1787680696, 1787681897, 1787683098, 1787684299, 1787685500, 1787686701,
    1787687902, 1787689103, 1787690304, 1787691505, 1787692706, 1787693907
];

describe('protocol_time', () => {

    describe('#medianTimePast', () => {
        it('takes the median of the newest 11, not of everything handed over', () => {
            // 24 values; only the newest 11 may participate. If the whole array were
            // medianed the answer would sit far lower.
            const many = [];
            for(let i = 0; i < 24; i++) many.push(1000 + i * 100);
            const newest11 = many.slice(-11).sort((a, b) => a - b);
            assert.strictEqual(medianTimePast(many), newest11[5]);
        });

        it('does not care what order the caller supplies', () => {
            const shuffled = TESTNET4.slice(0, 11).slice().reverse();
            assert.strictEqual(medianTimePast(shuffled), medianTimePast(TESTNET4.slice(0, 11)));
        });

        it('medians a short window rather than refusing, so a fresh chain still advances', () => {
            assert.strictEqual(medianTimePast([500, 100, 300]), 300);
            assert.strictEqual(medianTimePast([42]), 42);
        });

        it('returns null when nothing usable is supplied, so callers fall back to the raw stamp', () => {
            assert.strictEqual(medianTimePast([]), null);
            assert.strictEqual(medianTimePast(null), null);
            assert.strictEqual(medianTimePast('nope'), null);
            assert.strictEqual(medianTimePast([0, -5, NaN, null, undefined]), null);
        });

        it('drops unusable entries but still medians the rest', () => {
            assert.strictEqual(medianTimePast([100, NaN, 200, null, 300]), 200);
        });
    });

    // The whole point of the change, asserted against the chain that motivated it.
    describe('median-time-past on real testnet4 data', () => {
        it('confirms the 1201s minimum-difficulty spacing the fixture depends on', () => {
            for(let i = 1; i < TESTNET4.length; i++)
                assert.strictEqual(TESTNET4[i] - TESTNET4[i - 1], 1201);
        });

        it('lands well BEHIND the newest stamp, which is what lets a barrier clear', () => {
            const prev11 = TESTNET4.slice(0, 11);
            const mtp    = medianTimePast(prev11);
            const tip    = TESTNET4[11];
            assert.strictEqual(mtp, 1787686701);
            // ~6 blocks of lag: exactly the property that keeps MTP out of the future
            // on a chain whose stamps outrun wall clock.
            assert.strictEqual(tip - mtp, 7206);
        });

        it('stays behind wall clock even when the block itself is stamped in the FUTURE', () => {
            // Project the chain forward: the next stamps are +1201s each, so they are
            // dated ahead of "now". This is the exact state that stalled the indexer.
            const now      = TESTNET4[11];             // pretend wall clock is at the last real block
            const future   = now + 1201 * 2;           // a block stamped ~40 min ahead
            const window   = TESTNET4.slice(1);        // the 11 blocks below it
            const resolved = protocolTime('testnet', future, window);
            assert.ok(future > now, 'fixture must actually be future-dated');
            assert.ok(resolved < now, 'protocol time must not be in the future');
        });
    });

    describe('#isProtocolTimeMtpActive', () => {
        // testnet only. regtest is deliberately excluded: its block times come from
        // the harness clock (setmocktime), so a median over them is not the
        // well-behaved quantity it is on a live chain, and the e2e fee-era suites are
        // calibrated to the raw stamp. mainnet is the operator's call to make.
        it('is on for testnet only, with mainnet and regtest left on the raw stamp', () => {
            assert.strictEqual(isProtocolTimeMtpActive('testnet'), true);
            assert.strictEqual(isProtocolTimeMtpActive('regtest'), false);
            assert.strictEqual(isProtocolTimeMtpActive('mainnet'), false);
        });

        it('reads false for an unknown network rather than switching consensus by accident', () => {
            assert.strictEqual(isProtocolTimeMtpActive('signet'), false);
            assert.strictEqual(isProtocolTimeMtpActive(undefined), false);
            assert.strictEqual(isProtocolTimeMtpActive(''), false);
            // Guards against a truthy-but-not-true value ever counting as armed.
            assert.strictEqual(PROTOCOL_TIME_MTP_NETWORKS.mainnet, false);
        });
    });

    describe('#protocolTime', () => {
        it('returns the raw stamp untouched on an unswitched network', () => {
            assert.strictEqual(protocolTime('mainnet', 1787693907, TESTNET4.slice(0, 11)), 1787693907);
        });

        it('returns MTP on a switched network', () => {
            assert.strictEqual(protocolTime('testnet', 1787693907, TESTNET4.slice(0, 11)), 1787686701);
        });

        it('never exceeds the raw stamp, even if the median somehow sits above it', () => {
            // A chain that jumped backwards: the block is stamped below its own history.
            const resolved = protocolTime('testnet', 1000, TESTNET4.slice(0, 11));
            assert.strictEqual(resolved, 1000);
        });

        it('falls back to the raw stamp when MTP cannot be computed', () => {
            assert.strictEqual(protocolTime('testnet', 1787693907, []), 1787693907);
            assert.strictEqual(protocolTime('testnet', 1787693907, null), 1787693907);
        });

        // Callers distinguish "no such block" from a real 0, so the sentinel has to
        // survive. Coercing it to a number here would mark every time-gated protocol
        // change inactive on this node only, which is a unilateral fork.
        it('preserves the false sentinel for an unresolvable block_time', () => {
            assert.strictEqual(protocolTime('testnet', false, TESTNET4), false);
            assert.strictEqual(protocolTime('mainnet', false, TESTNET4), false);
            assert.strictEqual(protocolTime('testnet', null, TESTNET4), null);
            assert.strictEqual(protocolTime('testnet', undefined, TESTNET4), undefined);
        });

        it('exposes Bitcoin\'s 11-block span as the constant callers window on', () => {
            assert.strictEqual(MEDIAN_TIME_SPAN, 11);
        });
    });

    // Regression guard for the defect that made the first cut of this change a FORK
    // rather than a fix. The mirror barriers were moved to protocol time while the
    // transaction rows still carried the decoder's raw stamp, so actions.js lifted
    // the raw value into data['BLOCK_TIME'] and every time-ranged price/oracle read
    // kept scanning a window that was still growing. Barriers early + reads late is
    // the one combination that diverges nodes; these pin the half that closes it.
    describe('#stampProtocolTime', () => {
        const rows = () => ([
            { tx_index: 1, block_time: 1787693907, data: 'a' },
            { tx_index: 2, block_time: 1787693907, data: 'b' }
        ]);

        it('replaces the decoder raw stamp on every row so the action path reads protocol time', () => {
            const txs = rows();
            const resolved = protocolTime('testnet', 1787693907, TESTNET4.slice(0, 11));
            const n = stampProtocolTime(txs, resolved);
            assert.strictEqual(n, 2);
            assert.strictEqual(txs[0].block_time, 1787686701);
            assert.strictEqual(txs[1].block_time, 1787686701);
            // The value actually differs from what the decoder handed over, otherwise
            // this test would pass just as well against the unfixed code.
            assert.ok(txs[0].block_time < 1787693907, 'must not still be the raw stamp');
        });

        it('mutates in place rather than returning a copy, since fan-out collapse already ran', () => {
            const txs = rows();
            const first = txs[0];
            stampProtocolTime(txs, 1234567);
            assert.strictEqual(first.block_time, 1234567, 'the caller holds these same objects');
        });

        it('leaves rows untouched for an unresolvable time rather than writing a sentinel', () => {
            for(const bad of [false, null, undefined]){
                const txs = rows();
                assert.strictEqual(stampProtocolTime(txs, bad), 0);
                assert.strictEqual(txs[0].block_time, 1787693907, 'raw stamp must survive');
            }
        });

        it('tolerates an empty or absent block without throwing on the consensus path', () => {
            assert.strictEqual(stampProtocolTime([], 1234567), 0);
            assert.strictEqual(stampProtocolTime(null, 1234567), 0);
            assert.strictEqual(stampProtocolTime(undefined, 1234567), 0);
        });

        it('skips non-object rows instead of decorating them', () => {
            const txs = [null, { block_time: 1 }, 'nope'];
            stampProtocolTime(txs, 999);
            assert.strictEqual(txs[1].block_time, 999);
            assert.strictEqual(txs[0], null);
            assert.strictEqual(txs[2], 'nope');
        });

        it('is a no-op in value terms on an unswitched network, where protocol time IS the raw stamp', () => {
            const txs = rows();
            const resolved = protocolTime('mainnet', 1787693907, TESTNET4.slice(0, 11));
            stampProtocolTime(txs, resolved);
            assert.strictEqual(txs[0].block_time, 1787693907);
        });
    });

    describe('span constant', () => {
        it('is Bitcoin\'s 11', () => {
            assert.strictEqual(MEDIAN_TIME_SPAN, 11);
        });
    });

    // A source-static ratchet, in the same spirit as the ORDER BY determinism guard.
    //
    // Testing stampProtocolTime in isolation proves the helper works and proves
    // NOTHING about whether the block loop calls it. That gap is not hypothetical:
    // the first cut of this change moved the barriers to protocol time and left the
    // transaction rows on the decoder's raw stamp, which is a fork, and every unit
    // test still passed because each half was individually correct. This asserts the
    // wiring, which is the part that was actually wrong.
    describe('XChainIndexer wiring (ratchet)', () => {
        const fs  = require('fs');
        const src = fs.readFileSync(require('path').join(__dirname, '../../src/XChainIndexer.js'), 'utf8');

        it('re-stamps the decoder transaction rows with protocol time', () => {
            assert.ok(/stampProtocolTime\(\s*blockTransactions\s*,\s*blockTime\s*\)/.test(src),
                'the block loop must stamp protocol time onto the rows actions.js reads, or every ' +
                'time-ranged price and oracle read silently keeps the decoder raw stamp');
        });

        it('persists and publishes the RAW stamp, not protocol time', () => {
            assert.ok(/createBlock\(blockToParse,\s*rawBlockTime\)/.test(src),
                'the stored block row must carry the chain\'s own timestamp; it is also the ' +
                'window other nodes median, so storing a derived value would compound');
            assert.ok(/pushChainTip\([^)]*rawBlockTime\)/.test(src),
                'the published chain tip is compared against wall clock for freshness');
        });

        it('resolves both clocks from the decoder rather than inventing one', () => {
            assert.ok(/getBlockTime\(blockToParse\)/.test(src), 'protocol clock');
            assert.ok(/getRawBlockTime\(blockToParse\)/.test(src), 'raw clock');
        });
    });
});

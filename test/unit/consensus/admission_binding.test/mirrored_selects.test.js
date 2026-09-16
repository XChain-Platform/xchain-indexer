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
 * The mirrored selects under the mirror-admission flag day: every select issues its
 * pre-train SQL text byte for byte below the activation and the guarded height form on
 * this chain's column above it, asserted as literal strings against a capturing stub.
 * Part of the suite whose entry is test/unit/admission_binding.test.js.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { NETWORK, ADMIT_AT, LEGACY_AT, load, ARMS } = require('./helpers/arms.js');
const { bindSettlementReads, LEGACY_SQL, c33, assertNeverBare, stubDb } = require('./helpers/select_sql.js');

const T = 1700000000;

describe('admission binding: the mirrored selects issue the C33 form above the activation and today\'s text below it', function () {

    for (const arm of ARMS) {
        describe(arm.name, function () {
            let h;
            before(function () { h = load(arm.activation); });
            after(function () { if (h) h.restore(); h = null; });

            // Below the activation in this arm: the inert arm at any height, and the realistic
            // arm at LEGACY_AT. There is no such height when armed at 0.
            const legacyHeights = arm.activation === null ? [0, LEGACY_AT, ADMIT_AT] : (arm.legacyBlock !== null ? [arm.legacyBlock] : []);

            for (const B of legacyHeights) {
                it('below the activation at B=' + B + ' every select is byte-identical to the pre-train statement', async function () {
                    const { db, captured } = stubDb(h, 'BTC');
                    await db.getEffectiveUnsettledMatches('BTC', T, 25, B);
                    await db.getEffectiveUndispatchedCalls('BTC', NETWORK, T, 25, B);
                    await db.getEffectiveUnprocessedCallResults('BTC', NETWORK, T, 25, B);
                    await db.getMirroredAttestationResponses(NETWORK, ['a'.repeat(64), 'b'.repeat(64)], T, B);
                    assert.strictEqual(captured[0].sql, LEGACY_SQL.matches);
                    assert.deepStrictEqual(captured[0].args, [NETWORK, T, 'BTC', 'BTC']);
                    assert.strictEqual(captured[1].sql, LEGACY_SQL.dispatches);
                    assert.deepStrictEqual(captured[1].args, [NETWORK, 'BTC', T]);
                    assert.strictEqual(captured[2].sql, LEGACY_SQL.resultsSingleDb);
                    assert.deepStrictEqual(captured[2].args, [NETWORK, 'BTC', T, 25]);
                    assert.strictEqual(captured[3].sql, LEGACY_SQL.attest);
                    assert.deepStrictEqual(captured[3].args, [NETWORK, T, 'a'.repeat(64), 'b'.repeat(64)]);
                    for (const c of captured) assert.ok(!/admit_block/.test(c.sql), 'no admission column may be named below the activation');

                    const remote = stubDb(h, 'BTC', { remoteMirror: true });
                    await remote.db.getEffectiveUnprocessedCallResults('BTC', NETWORK, T, 25, B);
                    assert.strictEqual(remote.captured[0].sql, LEGACY_SQL.resultsRemote);
                    assert.deepStrictEqual(remote.captured[0].args, [NETWORK, 'BTC', T]);
                    assert.strictEqual(remote.captured[0].remote, true);
                });

                it('below the activation at B=' + B + ' the bridge selects are byte-identical to the pre-train statements', async function () {
                    const captured = [];
                    const ctx = { indexerDb: { mirrorDb: () => bindSettlementReads({ doQuery: async (sql, args) => { captured.push({ sql, args }); return []; } }),
                                               doQuery: async () => [] },
                                  coin: 'DOGE', network: NETWORK, blockIndex: B, blockTime: T };
                    await h.BS.dueBridgeTransfers(ctx);
                    await h.BS.duePolicySnapshots(ctx);
                    assert.strictEqual(captured[0].sql, LEGACY_SQL.transfers);
                    assert.deepStrictEqual(captured[0].args, [NETWORK, T, 'DOGE']);
                    assert.strictEqual(captured[1].sql, LEGACY_SQL.policies);
                    assert.deepStrictEqual(captured[1].args, [NETWORK, T]);
                    assert.deepStrictEqual(h.BS.mirrorBindClause(ctx), { sql: 'effective_time <= ?', args: [T] });
                });
            }
        });
    }
});

describe('admission binding: the mirrored selects issue the C33 form above the activation and today\'s text below it', function () {

    for (const arm of ARMS) {
        describe(arm.name, function () {
            let h;
            before(function () { h = load(arm.activation); });
            after(function () { if (h) h.restore(); h = null; });

            it('a select handed no height reads as below the activation (the pre-train call shape)', async function () {
                const { db, captured } = stubDb(h, 'BTC');
                await db.getEffectiveUnsettledMatches('BTC', T, 25);
                await db.getEffectiveUnsettledMatches('BTC', T, 25, null);
                assert.strictEqual(captured[0].sql, LEGACY_SQL.matches);
                assert.strictEqual(captured[1].sql, LEGACY_SQL.matches);
                assert.deepStrictEqual(h.BS.mirrorBindClause({ coin: 'DOGE', network: NETWORK, blockTime: T }), { sql: 'effective_time <= ?', args: [T] });
            });

            if (arm.modernBlock !== null) {
                const B = arm.modernBlock;

                it('above the activation at B=' + B + ' the match, call and attest selects take the C33 form on this chain\'s column', async function () {
                    const { db, captured } = stubDb(h, 'BTC');
                    await db.getEffectiveUnsettledMatches('BTC', T, 25, B);
                    await db.getEffectiveUndispatchedCalls('BTC', NETWORK, T, 25, B);
                    await db.getEffectiveUnprocessedCallResults('BTC', NETWORK, T, 25, B);
                    await db.getMirroredAttestationResponses(NETWORK, ['a'.repeat(64), 'b'.repeat(64)], T, B);

                    assert.strictEqual(captured[0].sql, LEGACY_SQL.matches.replace('effective_time <= ?', c33('admit_block_btc')));
                    assert.deepStrictEqual(captured[0].args, [NETWORK, T, B, 'BTC', 'BTC']);
                    assert.strictEqual(captured[1].sql, LEGACY_SQL.dispatches.replace('effective_time <= ?', c33('admit_block_btc')));
                    assert.deepStrictEqual(captured[1].args, [NETWORK, 'BTC', T, B]);
                    assert.strictEqual(captured[2].sql, LEGACY_SQL.resultsSingleDb.replace('c.effective_time <= ?', c33('admit_block_btc', 'c.')));
                    assert.deepStrictEqual(captured[2].args, [NETWORK, 'BTC', T, B, 25]);
                    // The attest read names the one column the hub stamps on this table and
                    // reads it back for the selector and the verifier.
                    assert.strictEqual(captured[3].sql, LEGACY_SQL.attest
                        .replace('batch_action_index', 'batch_action_index, admit_block_btc')
                        .replace('effective_time <= ?', c33('admit_block_btc')));
                    assert.deepStrictEqual(captured[3].args, [NETWORK, T, B, 'a'.repeat(64), 'b'.repeat(64)]);
                    for (const c of captured) assertNeverBare(c.sql, c.sql.indexOf('c.admit') !== -1 ? 'c.admit_block_btc' : 'admit_block_btc');

                    const remote = stubDb(h, 'BTC', { remoteMirror: true });
                    await remote.db.getEffectiveUnprocessedCallResults('BTC', NETWORK, T, 25, B);
                    assert.strictEqual(remote.captured[0].sql, LEGACY_SQL.resultsRemote.replace('effective_time <= ?', c33('admit_block_btc')));
                    assert.deepStrictEqual(remote.captured[0].args, [NETWORK, 'BTC', T, B]);
                });
            }
        });
    }
});

describe('admission binding: the mirrored selects issue the C33 form above the activation and today\'s text below it', function () {

    for (const arm of ARMS) {
        describe(arm.name, function () {
            let h;
            before(function () { h = load(arm.activation); });
            after(function () { if (h) h.restore(); h = null; });

            if (arm.modernBlock !== null) {
                const B = arm.modernBlock;

                it('above the activation the column is THIS indexer\'s coin, spelled from config', async function () {
                    const { db, captured } = stubDb(h, 'DOGE');
                    await db.getEffectiveUnsettledMatches('DOGE', T, 25, B);
                    assert.strictEqual(captured[0].sql, LEGACY_SQL.matches.replace('effective_time <= ?', c33('admit_block_doge')));
                    assert.ok(captured[0].sql.indexOf('admit_block_btc') === -1);
                });

                it('above the activation at B=' + B + ' the bridge selects take the C33 form, the policy select with no chain clause', async function () {
                    const captured = [];
                    const ctx = { indexerDb: { mirrorDb: () => bindSettlementReads({ doQuery: async (sql, args) => { captured.push({ sql, args }); return []; } }),
                                               doQuery: async () => [] },
                                  coin: 'DOGE', network: NETWORK, blockIndex: B, blockTime: T };
                    await h.BS.dueBridgeTransfers(ctx);
                    await h.BS.duePolicySnapshots(ctx);
                    assert.strictEqual(captured[0].sql, LEGACY_SQL.transfers.replace('effective_time <= ?', c33('admit_block_doge')));
                    assert.deepStrictEqual(captured[0].args, [NETWORK, T, B, 'DOGE']);
                    assert.strictEqual(captured[1].sql, LEGACY_SQL.policies.replace('effective_time <= ?', c33('admit_block_doge')));
                    assert.deepStrictEqual(captured[1].args, [NETWORK, T, B]);
                    assert.ok(!/_chain = \?/.test(captured[1].sql), 'the policy select carries no chain clause at any height');
                    for (const c of captured) assertNeverBare(c.sql, 'admit_block_doge');
                });

                it('bridge_settle and db.js spell the clause identically for the same column', function () {
                    const { db } = stubDb(h, 'DOGE');
                    const fromDb = db.mirrorBindClause(T, B);
                    const fromBs = h.BS.mirrorBindClause({ coin: 'DOGE', network: NETWORK, blockIndex: B, blockTime: T });
                    assert.deepStrictEqual(fromBs, fromDb);
                    assert.strictEqual(fromDb.sql, c33('admit_block_doge'));
                    assert.deepStrictEqual(fromDb.args, [T, B]);
                });

                it('a string height is a height and a null one is not (Number(null) is 0)', async function () {
                    const { db, captured } = stubDb(h, 'BTC');
                    await db.getEffectiveUnsettledMatches('BTC', T, 25, String(B));
                    await db.getEffectiveUnsettledMatches('BTC', T, 25, null);
                    await db.getEffectiveUnsettledMatches('BTC', T, 25, undefined);
                    assert.ok(captured[0].sql.indexOf('admit_block_btc') !== -1, 'a digit string is a height');
                    assert.deepStrictEqual(captured[0].args, [NETWORK, T, B, 'BTC', 'BTC']);
                    assert.strictEqual(captured[1].sql, LEGACY_SQL.matches, 'null is not height 0');
                    assert.strictEqual(captured[2].sql, LEGACY_SQL.matches, 'undefined is not height 0');
                });
            }
        });
    }
});

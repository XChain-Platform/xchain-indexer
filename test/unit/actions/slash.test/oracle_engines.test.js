// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// SLASH action handler: the XORACLE engine and its round discrimination, and
// the XORACLEB price batch canonicals under their own tag and composite round
// id.
// Part of the SLASH suite; see ../slash.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const eq    = require('../../../../src/equivocation_header.js');
const { buried, params, data, useSlashHarness } = require('./helpers/slash_harness.js');

// Each test gets a fresh harness from useSlashHarness; bind() hands it to the
// names the test bodies use.
let indexer, ctx, handler, offender;
const bind = (h) => { ({ indexer, ctx, handler, offender } = h); };

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('ACCEPTS an XORACLE equivocation (snapshot_block recovered from ROUND_ID)', async function () {
        const round = '150';   // the round id IS the BTC block
        const key   = eq.equivKey(eq.ENGINE_TAGS.ORACLE, round, 0);
        const msgA  = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, round, 0, '{"BTCUSD":"60000"}');
        const msgB  = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, round, 0, '{"BTCUSD":"61000"}');
        const d = data();
        await handler.parse(params('price', offender.pubHex,msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        // membership was checked at the round's block, buried
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['price', buried(150)]);
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce);
    });
});

// ── XORACLE round discrimination (, gated SLASH_ORACLE_ROUND_DISCRIMINATED) ──
//
// The EQUIV key for XORACLE is `XORACLE|<btc_height>|0` (ed25519.buildPriceV0Payload),
// but oracle rounds advance on wall-clock while the captured BTC tip can stand still,
// so an honest validator's rounds N and N+1 share that key and differ in content. Ungated,
// that pair reaches STATUS=valid and burns the whole bond.
function priceContent(round, btcHeight, price) {
    return JSON.stringify({
        round: round, timestamp: 1700000000, btc_block_height: btcHeight,
        pairs: [{ pair: 'BTCUSD', price: String(price) }]
    });
}

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('REJECTS an XORACLE pair whose signed contents declare DIFFERENT rounds', async function () {
        const height = '961123';
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, height, 0, priceContent(100, 961123, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, height, 0, priceContent(101, 961123, 61000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.notStrictEqual(d['STATUS'], 'valid');
        assert.ok(String(d['STATUS']).indexOf('ORACLE round mismatch') >= 0, 'got: ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled,
            'an honest validator signing two distinct rounds at one BTC tip must keep its bond');
    });

    it('still ACCEPTS a real same-round XORACLE double-sign', async function () {
        const height = '961123';
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, height, 0, priceContent(100, 961123, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, height, 0, priceContent(100, 961123, 61000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['price', buried(961123)]);
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce, 'genuine equivocation must still burn');
    });

    it('REJECTS an XORACLE pair whose content height disagrees with the EQUIV ROUND_ID', async function () {
        const height = '961123';
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, height, 0, priceContent(100, 961123, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, height, 0, priceContent(100, 961999, 61000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.notStrictEqual(d['STATUS'], 'valid');
        assert.ok(String(d['STATUS']).indexOf('ORACLE btc_block_height') >= 0, 'got: ' + d['STATUS']);
    });

    it('below the flag-day the pre-fix behavior is byte-identical (distinct rounds still slash)', async function () {
        ctx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) =>
            name !== 'SLASH_ORACLE_ROUND_DISCRIMINATED');
        const height = '961123';
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, height, 0, priceContent(100, 961123, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, height, 0, priceContent(101, 961123, 61000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid', 'the gate must leave sub-flag-day acceptance untouched');
    });
});

// ── XORACLEB: PRICE batch canonicals ──
//
// A batch canonical declares first_round/last_round and NO scalar `round`, which is the
// exact shape the XORACLE leg's invariant ("a content with no `round` cannot have come
// from buildPriceV0Payload") does not cover: under a shared tag its distinct-rounds
// guard would skip, and an honest validator that signed one v0 round and one batch
// at the same BTC anchor would read as a provable equivocator, for a full bond burn
// plus permanent capability disqualification. The distinct tag plus the composite
// ROUND_ID `<anchor>|<first_round>|<last_round>` is what keeps that from happening.

// buildPriceBatchPayload's emitted JSON (key order as the builder emits it).
function batchContent(first, last, btcHeight, price) {
    return JSON.stringify({
        first_round: first, last_round: last, btc_block_height: btcHeight,
        rounds: [{ round: first, timestamp: 1700000000, btc_block_height: btcHeight,
                   pairs: [{ pair: 'BTCUSD', price: String(price) }] }]
    });
}
const batchRoundId = (anchor, first, last) => [anchor, first, last].join('|');

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('ACCEPTS a genuine XORACLEB equivocation (two batches over ONE window at one anchor)', async function () {
        const anchor = 961123;
        const rid = batchRoundId(anchor, 100, 105);
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 105, anchor, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 105, anchor, 61000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid', 'got ' + d['STATUS']);
        // The capability map must route XORACLEB to `price`, and the snapshot block must be
        // the FIRST segment of the composite round id, not the whole id, resolved buried.
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['price', buried(anchor)]);
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce, 'a real double-signed batch must burn');
    });

    it('REJECTS an honest v0 round paired with an honest batch at ONE anchor', async function () {
        // The defect this row exists to prevent: under a shared engine tag these two share
        // the equiv key, differ in content, and burn a full bond off two honest signatures.
        const anchor = 961123;
        const v0 = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE, String(anchor), 0, priceContent(100, anchor, 60000));
        const v2 = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, batchRoundId(anchor, 100, 105), 0,
                                          batchContent(100, 105, anchor, 60000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, v0, offender.privateKey, v2, offender.privateKey), d, null);

        assert.notStrictEqual(d['STATUS'], 'valid', 'an honest v0 round and an honest batch are not one slot');
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled,
            'a validator that signed one honest round and one honest batch must keep its bond');
    });

    it('REJECTS two honest batches that split ONE window differently at one anchor', async function () {
        // Two leaders may legitimately cut the same window at different points, so the
        // window is in the round id and the two batches never collide on one key.
        const anchor = 961123;
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, batchRoundId(anchor, 100, 105), 0,
                                            batchContent(100, 105, anchor, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, batchRoundId(anchor, 100, 102), 0,
                                            batchContent(100, 102, anchor, 60000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.notStrictEqual(d['STATUS'], 'valid', 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled,
            'two honest sub-ranges at one anchor must keep the bond');
    });
});

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('REJECTS a batch pair sharing one key whose contents declare DIFFERENT windows', async function () {
        // The in-content leg of the same defence: contents that end at different rounds are
        // two messages, not two versions of one, whatever the shared header says.
        const anchor = 961123;
        const rid = batchRoundId(anchor, 100, 105);
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 105, anchor, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 102, anchor, 60000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.notStrictEqual(d['STATUS'], 'valid', 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled,
            'a window that differs only at its LAST round is still a distinct window');
    });

    it('REJECTS a batch pair whose content anchor disagrees with the ROUND_ID anchor', async function () {
        const anchor = 961123;
        const rid = batchRoundId(anchor, 100, 105);
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 105, anchor, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 105, 961999, 61000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(String(d['STATUS']).indexOf('ORACLE_BATCH btc_block_height') >= 0, 'got: ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS an XORACLEB round id that is not <anchor>|<first>|<last>', async function () {
        // The membership snapshot is read off segment 0, so a round id of another shape
        // must never resolve to a block at all.
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, '961123|100', 0, batchContent(100, 105, 961123, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, '961123|100', 0, batchContent(100, 105, 961123, 61000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(String(d['STATUS']).indexOf('ORACLE_BATCH round id') >= 0, 'got: ' + d['STATUS']);
        assert.ok(indexer.indexerDb.getValidatorsByCapability.notCalled);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });
});

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('REJECTS an XORACLEB round id whose window runs backwards', async function () {
        const rid = batchRoundId(961123, 105, 100);
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(105, 100, 961123, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(105, 100, 961123, 61000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(String(d['STATUS']).indexOf('ORACLE_BATCH window') >= 0, 'got: ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('REJECTS an XORACLEB proof labelled with a capability other than price', async function () {
        const rid = batchRoundId(961123, 100, 105);
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 105, 961123, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 105, 961123, 61000));
        const d = data();
        await handler.parse(params('oracle_publish', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/CAPABILITY \(does not match engine\)/.test(d['STATUS']), 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });

    it('the XORACLEB discrimination is NOT gated on SLASH_ORACLE_ROUND_DISCRIMINATED', async function () {
        // A new tag has no pre-fix verdicts to reproduce, so there must be no height window
        // in which two honest splits burn a bond.
        ctx.protocolChanges.isEnabled = sinon.stub().callsFake(async (name) =>
            name !== 'SLASH_ORACLE_ROUND_DISCRIMINATED');
        const anchor = 961123;
        const rid = batchRoundId(anchor, 100, 105);
        const msgA = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 105, anchor, 60000));
        const msgB = eq.buildEquivCanonical(eq.ENGINE_TAGS.ORACLE_BATCH, rid, 0, batchContent(100, 102, anchor, 60000));
        const d = data();
        await handler.parse(params('price', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.notStrictEqual(d['STATUS'], 'valid', 'got ' + d['STATUS']);
        assert.ok(indexer.indexerDb.slashCapabilityStake.notCalled);
    });
});

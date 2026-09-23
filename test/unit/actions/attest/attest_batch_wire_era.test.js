// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// THE ATTEST BATCH ROW FIELD SET IS CHOSEN BY THE BATCH'S OWN ANCHOR.
//
// admit_block_btc joined the batch rows with the mirror admission producer
// activation, and the batch rail was already publishing hourly on testnet before
// that: every batch on chain below the activation was signed over the legacy
// field set and carries no admit_block_btc. Requiring or signing the field on
// those batches forks three ways at once: an upgraded indexer refuses an old
// hub's batch that an old indexer accepts, an old indexer refuses an upgraded
// hub's signature, and a replay from genesis refuses every historical batch.
//
// So the wire signs and requires the field only when the batch's signed
// btc_block_height is at or above MIRROR_ADMISSION_ACTIVATION['BTC:<network>'].
// This suite drives that rule on the SHIPPED testnet height, read from the
// registry and never typed here, through the real gate with nothing stubbed, and
// replays a batch the v0.19.0 wire code encoded and signed.

'use strict';

const assert = require('assert');
const sinon  = require('sinon');

const abw = require('../../../../src/actions/attest/attest_batch_wire.js');
const adm = require('../../../../src/consensus/gates/mirror_admission_gate.js');
const ed25519 = require('../../../../src/consensus/ed25519.js');
const { window_, toParams } = require('../../../helpers/attest_batch_wire_fixture.js');
const { batchHandler, batchData } = require('../../../helpers/attest_batch_rail_fixture.js');
const HISTORY = require('../../../fixtures/attest_batch_v0190_replay.json');

const { isAdmissionEra } = adm;
const NETWORK  = 'testnet';
const ADMIT_AT = adm.MIRROR_ADMISSION_ACTIVATION['BTC:' + NETWORK];
// The testnet height the batch rail armed at; history on chain starts here.
const RAIL_ARMED_AT = 151324;

// A testnet window at `anchor`. The fixture rows carry admit_block_btc, which is what an
// upgraded hub's rows hold; `withoutAdmission` strips it, the shape an older hub signs.
function testnetWindow(anchor, withoutAdmission) {
    const win = window_(3, undefined, { network: NETWORK, btc_block_height: anchor });
    win.rows = win.rows.map((r) => {
        const row = { ...r, network: NETWORK };
        if (withoutAdmission) delete row.admit_block_btc;
        return row;
    });
    return win;
}

function reassembled(enc) {
    return abw.reassembleAttestBatch(abw.parseAttestBatchHead(toParams(enc.wires[0])), [], isAdmissionEra);
}

function theRuleAndItsRegistry() {
    it('the testnet producer height is sized, so both sides of the boundary are real', function () {
        assert.ok(Number.isInteger(ADMIT_AT) && ADMIT_AT > RAIL_ARMED_AT,
            'MIRROR_ADMISSION_ACTIVATION[BTC:testnet] is ' + ADMIT_AT);
        assert.strictEqual(isAdmissionEra(NETWORK, ADMIT_AT - 1), false);
        assert.strictEqual(isAdmissionEra(NETWORK, ADMIT_AT), true);
    });

    it('the legacy set is the admission set without admit_block_btc, which follows effective_time', function () {
        assert.strictEqual(abw.ATTEST_BATCH_LEGACY_ROW_FIELDS.includes('admit_block_btc'), false);
        const expected = abw.ATTEST_BATCH_LEGACY_ROW_FIELDS.slice();
        expected.splice(expected.indexOf('effective_time') + 1, 0, 'admit_block_btc');
        assert.deepStrictEqual(abw.ATTEST_BATCH_ADMISSION_ROW_FIELDS, expected);
        assert.deepStrictEqual(abw.ATTEST_BATCH_ROW_FIELDS, abw.ATTEST_BATCH_ADMISSION_ROW_FIELDS,
            'the read/projection list is the superset');
    });

    it('picks the set from the batch anchor: legacy below, admission at and above, legacy on mainnet', function () {
        assert.strictEqual(abw.attestBatchRowFields(NETWORK, ADMIT_AT - 1, isAdmissionEra), abw.ATTEST_BATCH_LEGACY_ROW_FIELDS);
        assert.strictEqual(abw.attestBatchRowFields(NETWORK, ADMIT_AT, isAdmissionEra), abw.ATTEST_BATCH_ADMISSION_ROW_FIELDS);
        assert.strictEqual(abw.attestBatchRowFields(NETWORK, String(ADMIT_AT + 5), isAdmissionEra), abw.ATTEST_BATCH_ADMISSION_ROW_FIELDS);
        assert.strictEqual(abw.attestBatchRowFields('mainnet', 10000000, isAdmissionEra), abw.ATTEST_BATCH_LEGACY_ROW_FIELDS,
            'mainnet is null under the write hold, so no anchor arms it');
    });

    it('refuses to sign, encode or check a batch without an era predicate', function () {
        const win = testnetWindow(ADMIT_AT, false);
        const head = abw.parseAttestBatchHead(toParams(abw.encodeAttestBatch(win, isAdmissionEra).wires[0]));
        for (const call of [() => abw.buildAttestBatchCanonical(win), () => abw.buildAttestBatchBody(win),
                            () => abw.encodeAttestBatch(win), () => abw.reassembleAttestBatch(head, []),
                            () => abw.attestBatchRowFields(NETWORK, ADMIT_AT)])
            assert.throws(call, /admission-era predicate/);
    });
}

function belowTheActivation() {
    it('a batch without the field encodes, reassembles and signs the legacy bytes', function () {
        const win = testnetWindow(ADMIT_AT - 1, true);
        const out = reassembled(abw.encodeAttestBatch(win, isAdmissionEra));
        assert.strictEqual(out.ok, true, out.status);
        assert.deepStrictEqual(Object.keys(out.batch.rows[0]), abw.ATTEST_BATCH_LEGACY_ROW_FIELDS);
        assert.strictEqual(abw.buildAttestBatchCanonical(win, isAdmissionEra).includes('admit_block_btc'), false);
    });

    it('a row that holds an admission height still signs and carries none of it', function () {
        const withHeight = testnetWindow(ADMIT_AT - 1, false);
        const without    = testnetWindow(ADMIT_AT - 1, true);
        assert.strictEqual(abw.buildAttestBatchCanonical(withHeight, isAdmissionEra),
                           abw.buildAttestBatchCanonical(without, isAdmissionEra),
            'an upgraded hub signs the bytes an older hub and every older indexer rebuild');
        assert.strictEqual(abw.buildAttestBatchBody(withHeight, isAdmissionEra).includes('admit_block_btc'), false);
    });
}

function atTheActivation() {
    it('a batch whose rows lack the field is refused ROW_FIELD admit_block_btc', function () {
        // Encoded with the legacy set at an era anchor: the batch a hub that never
        // armed would publish past the flag day.
        const enc = abw.encodeAttestBatch(testnetWindow(ADMIT_AT, true), () => false);
        const out = reassembled(enc);
        assert.strictEqual(out.ok, false);
        assert.strictEqual(out.reason, abw.ATTEST_BATCH_FAIL_REASONS.ROW_FIELD);
        assert.strictEqual(out.detail, 'admit_block_btc');
    });

    it('a batch carrying the field reassembles it and signs it', function () {
        const win = testnetWindow(ADMIT_AT, false);
        const out = reassembled(abw.encodeAttestBatch(win, isAdmissionEra));
        assert.strictEqual(out.ok, true, out.status);
        assert.deepStrictEqual(Object.keys(out.batch.rows[0]), abw.ATTEST_BATCH_ADMISSION_ROW_FIELDS);
        assert.strictEqual(out.batch.rows[1].admit_block_btc, win.rows[1].admit_block_btc);
        assert.strictEqual(abw.buildAttestBatchCanonical(out.batch, isAdmissionEra),
                           abw.buildAttestBatchCanonical(win, isAdmissionEra));
        const moved = { ...win, rows: win.rows.map((r, i) => i === 1 ? { ...r, admit_block_btc: r.admit_block_btc + 1 } : r) };
        assert.notStrictEqual(abw.buildAttestBatchCanonical(moved, isAdmissionEra),
                              abw.buildAttestBatchCanonical(win, isAdmissionEra),
            'the admission height is inside the signed preimage');
    });
}

function replayingHistory() {
    it('the fixture is a pre-activation testnet batch from the armed rail', function () {
        assert.strictEqual(HISTORY.network, NETWORK);
        assert.ok(HISTORY.btc_block_height >= RAIL_ARMED_AT && HISTORY.btc_block_height < ADMIT_AT,
            'fixture anchor ' + HISTORY.btc_block_height);
        assert.strictEqual(HISTORY.signed_canonical.includes('admit_block_btc'), false);
    });

    it('a batch the v0.19.0 wire signed reassembles and its signature verifies over the rebuilt canonical', function () {
        const head = abw.parseAttestBatchHead(toParams(HISTORY.wire));
        assert.strictEqual(head.ok, true, head.status);
        assert.strictEqual(head.batchKey, HISTORY.batch_key);
        const out = abw.reassembleAttestBatch(head, [], isAdmissionEra);
        assert.strictEqual(out.ok, true, out.status);
        const canonical = abw.buildAttestBatchCanonical(out.batch, isAdmissionEra);
        assert.strictEqual(canonical, HISTORY.signed_canonical, 'the rebuilt bytes are the bytes that were signed');
        assert.strictEqual(ed25519.verify(canonical, out.batch.sigs[0].sig, HISTORY.signer_pubkey), true);
    });

    it('the DOGE handler lands that historical head valid and stages its hub push', async function () {
        const { handler, db, ix } = batchHandler('DOGE');
        ix.config.NETWORK = NETWORK;
        db.getValidatorsByCapability   = sinon.stub().resolves([{ pubkey: HISTORY.signer_pubkey }]);
        db.getStakeWeightsByCapability = sinon.stub().resolves([{ pubkey: HISTORY.signer_pubkey, source: 'SA', weight: '100' }]);
        db.hasCapability               = sinon.stub().resolves(true);
        const data = batchData();
        await handler.parse(toParams(HISTORY.wire), data, null);
        assert.strictEqual(data['STATUS'], 'valid');
        assert.strictEqual(data['REQUEST_ID'], HISTORY.batch_key);
        assert.ok(db.enqueueHubPushTx.calledOnce, 'a replayed historical batch reaches the hub push');
    });
}

describe('ATTEST batch wire: the admission-era row field set @regression @tier2', function () {
    describe('the rule and the registry it reads', theRuleAndItsRegistry);
    describe('below the activation', belowTheActivation);
    describe('at the activation', atTheActivation);
    describe('replaying history', replayingHistory);
});

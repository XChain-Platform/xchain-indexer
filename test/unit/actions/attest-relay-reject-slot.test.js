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
 * test/unit/actions/attest-relay-reject-slot.test.js
 *
 * A refused ATTEST v3 must not occupy the request_id it named.
 *
 * WHY THIS FILE EXISTS. The sibling relay tests reach the database through
 * sinon stubs, which can prove that createAttestationRequest was CALLED but
 * never that its row survived. The whole defect lives in the gap between those
 * two: the v3 admission lookups already skip refused rows, so the federation's
 * real relay is admitted and stamped valid/pending, and then the single-v0
 * guard inside createAttestationRequest counts the griefer's stored refusal and
 * drops the honest row with a console warning. A stubbed db is green through
 * every step of that.
 *
 * So this file runs the REAL createAttestationRequest and the REAL relay
 * lookups against an in-memory attests table, and asserts on the rows that
 * survive rather than on the calls that were made. Both sides of the flag day
 * are driven: with the gate off the failure reproduces exactly, which is what
 * makes the gate-on case evidence rather than a tautology.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');

const Attest          = require('../../../src/actions/attest.js');
const Database        = require('../../../src/db.js');
const swq             = require('../../../src/stake_weighted_quorum.js');
const ed25519         = require('../../../src/ed25519.js');
const attestRelay     = require('../../../src/attest_relay_activation.js');
const relayRejectSlot = require('../../../src/attest_relay_reject_slot_activation.js');

const PUBKEY_A = 'a'.repeat(64);
const SIG_A    = '1'.repeat(128);
// The id the federation is about to relay. Public on the origin chain before the
// home-chain broadcast, which is the entire premise of the griefing attack.
const REQ_ID   = 'd'.repeat(64);

// The griefer's wire: the real id, an unknown provider. Any refusal reason works;
// what matters is that the verdict is 'rejected' and the row is stored.
function v3Params(o = {}) {
    return [
        3,
        o.requestId      !== undefined ? o.requestId      : REQ_ID,
        o.originChain    !== undefined ? o.originChain    : 'LTC',
        o.originAction   !== undefined ? o.originAction   : 4242,
        o.providerId     !== undefined ? o.providerId     : 'http_get',
        o.payload        !== undefined ? o.payload        : 'https://example.com/score',
        o.redundancy     !== undefined ? o.redundancy     : 1,
        o.deadlineBlocks !== undefined ? o.deadlineBlocks : 10,
        o.snapshotBlock  !== undefined ? o.snapshotBlock  : 100,
        1, PUBKEY_A, SIG_A,
    ];
}

/**
 * An in-memory stand-in for the `attests` table, driven by the product's own SQL.
 *
 * Statements are matched on their distinguishing clause rather than replayed by
 * hand, so a predicate that changes shape in src/db.js stops matching here and
 * fails loudly instead of being silently mirrored by a hand-written twin.
 *
 * @returns {{rows: Object[], run: function(string, Array): Promise<Object[]>}}
 */
function makeAttestsTable() {
    const rows = [];
    async function run(sql, args = []) {
        const q = String(sql).replace(/\s+/g, ' ').trim();

        const ins = q.match(/^INSERT INTO attests \(([^)]+)\) VALUES \(([^)]+)\)/i);
        if (ins) {
            const cols = ins[1].split(',').map(s => s.trim());
            const vals = ins[2].split(',').map(s => s.trim());
            const row  = {};
            let next = 0;
            vals.forEach((v, i) => { row[cols[i]] = (v === '?') ? args[next++] : JSON.parse(v); });
            rows.push(row);
            return [];
        }
        if (/^UPDATE attests SET/i.test(q)) {
            throw new Error('the UPDATE branch is not exercised by these fixtures');
        }
        // createAttestationRequest's action_index existence probe.
        if (/FROM attests WHERE action_index=\?/i.test(q)) {
            return rows.filter(r => Number(r.action_index) === Number(args[0]));
        }
        // getRelayRequestById: the v3 request_id admission guard.
        if (/WHERE request_id = \? AND version = 0 AND request_status <> 'rejected'/i.test(q)) {
            return rows.filter(r => r.request_id === args[0] && Number(r.version) === 0 &&
                                    r.request_status !== 'rejected')
                       .sort((a, b) => Number(a.action_index) - Number(b.action_index))
                       .slice(0, 1);
        }
        // getRelayRequestByOrigin: the relay-identity admission guard.
        if (/WHERE origin_chain = \? AND origin_action_index = \?/i.test(q)) {
            return rows.filter(r => r.origin_chain === args[0] &&
                                    Number(r.origin_action_index) === Number(args[1]) &&
                                    Number(r.version) === 0 && r.request_status !== 'rejected')
                       .sort((a, b) => Number(a.action_index) - Number(b.action_index))
                       .slice(0, 1);
        }
        // createAttestationRequest's single-v0 guard, which is the defect under test.
        if (/FROM attests WHERE request_id=\? AND version=0/i.test(q)) {
            return rows.filter(r => r.request_id === args[0] && Number(r.version) === 0).slice(0, 1);
        }
        throw new Error('unmapped statement reached the attests fixture: ' + q);
    }
    return { rows, run };
}

describe('a refused ATTEST v3 and the request_id slot @regression @tier1', function () {

    let indexer, handler, table, warn;

    beforeEach(function () {
        indexer = createMockIndexer();
        table   = makeAttestsTable();

        // A real Database, so createAttestationRequest and the two relay lookups are
        // the shipped implementations. The pool is replaced before any connect.
        const db = new Database('127.0.0.1', 3306, 'x', 'u', 'p',
                                { config: indexer.config, util: indexer.util });
        db.pool = { getConnection: sinon.stub().resolves({}) };
        sinon.stub(db, 'doQuery').callsFake(table.run);
        sinon.stub(db, 'doQueryStrict').callsFake(table.run);
        sinon.stub(db, 'createStatus').resolves(1);
        sinon.stub(db, 'getAddressId').resolves(null);

        // Everything the v3 path needs that is not the attests table itself.
        db.getValidatorsByCapability   = sinon.stub().resolves([{ pubkey: PUBKEY_A }]);
        db.getStakeWeightsByCapability = sinon.stub().resolves([{ pubkey: PUBKEY_A, source: 'SA', weight: '100' }]);
        db.hasCapability               = sinon.stub().resolves(true);
        db.getContract                 = sinon.stub().resolves({ contract_index: 5 });
        indexer.indexerDb = db;

        handler = new Attest({
            config:    indexer.config,
            util:      indexer.util,
            mapper:    indexer.mapper,
            decoderDb: indexer.decoderDb,
            indexerDb: db,
            actionExecute:   { parse: sinon.stub().resolves() },
            protocolChanges: {
                isDefined: sinon.stub().returns(true),
                isEnabled: sinon.stub().resolves(true),
            },
        });
        indexer.config['COIN'] = 'BTC';
        indexer.util.resetLists();

        sinon.stub(swq, 'isStakeWeightedQuorumActive').returns(false);
        sinon.stub(ed25519, 'verify').returns(true);
        sinon.stub(attestRelay, 'isAttestRelayActive').returns(true);
        // Keep the dropped-row warning out of the suite's output; it is also the
        // product's own signal that the defect fired, so the legacy case asserts on it.
        warn = sinon.stub(console, 'warn');
    });

    afterEach(function () {
        sinon.restore();
    });

    // The griefer's wire and then the federation's, in that order, into one table.
    async function runGriefThenRelay() {
        const griefData = createBaseData({ ACTION: 'ATTEST', FORMAT: 3,
                                           BLOCK_INDEX: 900000, ACTION_INDEX: 10 });
        await handler.parse(v3Params({ providerId: 'not_a_registered_provider' }), griefData, null);

        const relayData = createBaseData({ ACTION: 'ATTEST', FORMAT: 3,
                                           BLOCK_INDEX: 900001, ACTION_INDEX: 11 });
        await handler.parse(v3Params(), relayData, null);

        return { griefData, relayData };
    }

    const pendingRows = () => table.rows.filter(r => r.request_status === 'pending');

    it('below the flag day the refusal is stored and the honest relay never persists', async function () {
        sinon.stub(relayRejectSlot, 'isAttestRelayRejectSlotActive').returns(false);

        const { griefData, relayData } = await runGriefThenRelay();

        assert.ok(String(griefData['STATUS']).startsWith('invalid:'), 'the grief wire is refused');
        assert.strictEqual(relayData['STATUS'], 'valid', 'the federation wire is admitted');
        assert.strictEqual(relayData['REQUEST_STATUS'], 'pending');

        assert.strictEqual(table.rows.length, 1, 'only the refusal reached the table');
        assert.strictEqual(table.rows[0].request_status, 'rejected');
        assert.strictEqual(pendingRows().length, 0,
            'the admitted relay was dropped by the single-v0 guard: no pending row exists');
        assert.ok(warn.getCalls().some(c => String(c.args[0]).includes('duplicate v0 for request_id')),
            'the drop is silent apart from this warning');
    });

    it('at and above it the refusal persists nothing and the honest relay materializes', async function () {
        const { griefData, relayData } = await runGriefThenRelay();

        assert.ok(String(griefData['STATUS']).startsWith('invalid:'),
            'the grief wire is still refused, and its verdict still reaches the action row');
        assert.strictEqual(relayData['STATUS'], 'valid');

        assert.strictEqual(table.rows.length, 1, 'the refusal claimed no slot');
        assert.strictEqual(pendingRows().length, 1, 'the federation relay materialized');
        assert.strictEqual(pendingRows()[0].request_id, REQ_ID);
        assert.strictEqual(Number(pendingRows()[0].action_index), 11);
        assert.strictEqual(pendingRows()[0].origin_chain, 'LTC');
        assert.ok(!warn.getCalls().some(c => String(c.args[0]).includes('duplicate v0 for request_id')),
            'nothing was dropped');
    });

    it('an admitted relay still holds its id against a second admitted one', async function () {
        // The exactly-once rule the flag day must not loosen: withholding refusals is
        // not withholding the guard. A second federation v3 at the same id, admitted on
        // its own wire, is still refused and still persists no second pending row.
        const first = createBaseData({ ACTION: 'ATTEST', FORMAT: 3,
                                       BLOCK_INDEX: 900000, ACTION_INDEX: 20 });
        await handler.parse(v3Params(), first, null);

        const second = createBaseData({ ACTION: 'ATTEST', FORMAT: 3,
                                        BLOCK_INDEX: 900001, ACTION_INDEX: 21 });
        await handler.parse(v3Params({ originAction: 4243 }), second, null);

        assert.strictEqual(first['STATUS'], 'valid');
        assert.strictEqual(second['STATUS'], 'invalid: REQUEST_ID (already present on this chain)');
        assert.strictEqual(pendingRows().length, 1);
    });

    it('the real gate is unarmed on mainnet and genesis-active on testnet and regtest', function () {
        sinon.restore();
        const { ATTEST_RELAY_REJECT_SLOT_ACTIVATION: map,
                isAttestRelayRejectSlotActive: active } = relayRejectSlot;

        assert.strictEqual(map.mainnet, 9999999999, 'mainnet is on the house sentinel');
        assert.strictEqual(active(map.mainnet - 1, 'mainnet'), false);
        assert.strictEqual(active(map.mainnet, 'mainnet'), true);
        assert.strictEqual(active(0, 'testnet'), true);
        assert.strictEqual(active(0, 'regtest'), true);
        // Fail closed, never open: an unknown network or an unreadable timestamp keeps
        // the deployed behaviour rather than activating a consensus rule early.
        assert.strictEqual(active(9999999999, 'signet'), false);
        assert.strictEqual(active('not-a-time', 'regtest'), false);
        assert.strictEqual(active(undefined, 'regtest'), false);
    });
});

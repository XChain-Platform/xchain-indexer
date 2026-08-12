/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
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
 * test/unit/crossChainSettlementCapGate.test.js
 *
 * : the flag-day gate on the CROSS_SETTLE per-block cap.
 *
 * The cap itself (CROSS_SETTLE_MAX_PER_BLOCK, ) is consensus-visible:
 * deferring a settlement to a later block moves actions rows, the contract hash
 * and the checkpoint preimage. CROSS_CHAIN_DEX is genesis-active on every
 * network and the fresh-genesis restart of 816d1e1 covered the three TESTNET
 * chains only, so the live mainnet chains carry settled history an ungated cap
 * would reinterpret on any from-genesis replay, with no fleet-wide replay behind
 * it (which is the only reason the sibling ATTEST_MAX_EXPIRIES_PER_BLOCK could
 * ship ungated). The operator ruled on 2026-08-11, option (b): the cap lands
 * behind CROSS_SETTLE_PER_BLOCK_CAP in protocol_changes.js, not ungated under
 * the  §0 wipe-and-replay route.
 *
 * This suite pins both halves of that ruling:
 *   - the REGISTRATION: a time-keyed 2.0.0 change, genesis-active on testnet and
 *     regtest, mainnet parked on the UNARMED sentinel (the operator still owes
 *     the anchor, so no guessed height may ship);
 *   - the BEHAVIOR at the pass: gate ON settles the capped prefix, gate OFF
 *     drains the full effective backlog, which is the legacy pass byte for byte.
 *     A gate that changed nothing, or a cap that fired regardless of it, both
 *     pass a registration-only test and fork the fleet anyway.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createMockIndexer } = require('../fixtures/mocks');
const ProtocolChanges       = require('../../src/protocol_changes.js');
const Utility               = require('../../src/utility');
const PROTO                 = require('../../src/protocol/constants.js');

const GATE = 'CROSS_SETTLE_PER_BLOCK_CAP';

// A far-future instant no real chain will reach before the operator arms the
// gate deliberately: 2100-01-01, the same boundary the sibling  suite
// uses to tell a scheduled date from an UNARMED sentinel.
const YEAR_2100 = 4102444800;

function pcFor(network){
    const indexer = createMockIndexer();
    indexer.config.NETWORK = network;
    return { pc: new ProtocolChanges(indexer, '2.0.0'), indexer };
}

// n finalized matches in the deterministic (snapshot_block, match_id) order the
// settlement query returns them in.
function matches(n){
    const out = [];
    for(let i = 0; i < n; i++)
        out.push({ match_id: 'm' + String(i).padStart(4, '0'), snapshot_block: 1 });
    return out;
}

// Drives the real pass against a fake db + actions, returning the limit the pass
// asked for and the match_ids it settled.
async function runPass(gateOn, backlog){
    const util = new Utility();
    const all  = matches(backlog);
    const seen = [];
    let   asked = null;

    const db = {
        config: { COIN: 'BTC' },
        async getEffectiveUnsettledMatches(coin, block_time, limit){
            asked = limit;
            // Mirror the real method: exclude what earlier blocks settled, then
            // hand back the ordered prefix under whatever limit the caller set.
            const fresh = all.filter(m => !seen.includes(m.match_id));
            return fresh.slice(0, Number(limit) || PROTO.CROSS_SETTLE_MAX_PER_BLOCK);
        }
    };
    const actions = {
        protocolChanges: { isEnabled: sinon.stub().resolves(gateOn) },
        async processAction(name, _k, data){
            assert.strictEqual(name, 'CROSS_SETTLE');
            seen.push(data['MATCH'].match_id);
        }
    };

    await util.processCrossChainSettlements(actions, db, 100, 1700);
    return { asked, seen, actions, all };
}

describe('CROSS_SETTLE per-block cap flag day  @regression @tier1', function(){

    afterEach(() => sinon.restore());

    describe('registration', function(){

        it('is a time-keyed 2.0.0 change, genesis-active on testnet and regtest', function(){
            const change = pcFor('regtest').pc.changes[GATE];
            assert.ok(change, GATE + ' must be registered');
            assert.strictEqual(change.version_major, 2);
            assert.strictEqual(change.version_minor, 0);
            assert.strictEqual(change.version_revision, 0);
            // Time-keyed: CROSS_SETTLE runs on BTC, LTC and DOGE, whose heights
            // diverge by millions of blocks, so no single height names one cutover.
            assert.strictEqual(change.mainnet_block, 0);
            assert.strictEqual(change.testnet_block, 0);
            assert.strictEqual(change.regtest_block, 0);
            assert.strictEqual(change.testnet_time, 0);
            assert.strictEqual(change.regtest_time, 0);
        });

        it('mainnet is UNARMED: the operator owes the anchor, so no guessed height ships', function(){
            const sentinel = ProtocolChanges.CROSS_SETTLE_CAP_MAINNET_TIME;
            assert.strictEqual(typeof sentinel, 'number', 'the sentinel must be exported');
            assert.strictEqual(pcFor('mainnet').pc.changes[GATE].mainnet_time, sentinel);
            // A value inside any plausible chain lifetime means somebody armed a
            // consensus-visible tightening without the operator's flag day.
            assert.ok(sentinel > YEAR_2100,
                'the mainnet arm must stay a far-future UNARMED sentinel until the anchor is ratified');
        });

        it('regtest: capped from genesis, so drills and suites run the post-flag-day rule', async function(){
            const { pc, indexer } = pcFor('regtest');
            indexer.decoderDb.getBlockTime.resolves(1);
            assert.strictEqual(await pc.isEnabled(GATE, 0), true);
        });

        it('mainnet: inert at every plausible block time, so no settled block is reinterpreted', async function(){
            const { pc, indexer } = pcFor('mainnet');
            indexer.decoderDb.getBlockTime.resolves(YEAR_2100);
            assert.strictEqual(await pc.isEnabled(GATE, 1000000), false);
        });
    });

    describe('the pass honours the gate', function(){

        it('gate ON: settles the capped prefix and asks the db for exactly the protocol cap', async function(){
            const backlog = 4 * PROTO.CROSS_SETTLE_MAX_PER_BLOCK;
            const { asked, seen, all } = await runPass(true, backlog);
            assert.strictEqual(asked, PROTO.CROSS_SETTLE_MAX_PER_BLOCK,
                'the pass must hand the protocol cap down, not a local copy of the number');
            assert.strictEqual(seen.length, PROTO.CROSS_SETTLE_MAX_PER_BLOCK,
                'one block must not drain the whole backlog once the flag day has passed');
            assert.deepStrictEqual(seen, all.slice(0, PROTO.CROSS_SETTLE_MAX_PER_BLOCK).map(m => m.match_id),
                'the settled set must be the ordered PREFIX, or two operators settle different matches');
        });

        it('gate OFF: drains the full effective backlog, the legacy pass byte for byte', async function(){
            const backlog = 4 * PROTO.CROSS_SETTLE_MAX_PER_BLOCK;
            const { asked, seen, all } = await runPass(false, backlog);
            assert.strictEqual(seen.length, backlog,
                'pre-flag-day a mainnet block must settle everything effective, as it always has');
            assert.deepStrictEqual(seen, all.map(m => m.match_id));
            // The limit handed down must be truthy-and-huge rather than 0/undefined:
            // the db-side default reads a falsy limit as "caller forgot" and re-applies
            // the protocol cap, which would gate-bypass in the ON direction with the
            // flag day still unarmed.
            assert.ok(Number(asked) >= backlog,
                'the pre-flag-day limit must not be a falsy value the db turns back into the cap');
        });

        it('evaluates the gate per block, against the block being processed', async function(){
            const { actions } = await runPass(true, 5);
            assert.ok(actions.protocolChanges.isEnabled.calledOnce, 'the gate must be consulted every block');
            assert.deepStrictEqual(actions.protocolChanges.isEnabled.firstCall.args, [GATE, 100],
                'the gate must be evaluated against this block index, not a cached or later one');
        });
    });
});

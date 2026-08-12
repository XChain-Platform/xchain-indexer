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
 * test/unit/crossChainSettlementCap.test.js
 *
 * the CROSS_SETTLE pass was the one cross-chain pass with no
 * per-block cap. getEffectiveUnsettledMatches selected every finalized,
 * effective, unsettled match with no LIMIT and processCrossChainSettlements
 * looped all of them, so a hub backlog injected an unbounded number of
 * signature-verifying, escrow-releasing actions into a single block
 * transaction - the BLOCK_PROCESS_TIMEOUT shape the XCALL and ATTEST caps
 * already prevent.
 *
 * These pin the cap, the fact that it is applied AFTER the settled-set
 * exclusion (so it counts real work, not history), and the carry-forward: the
 * overflow is never dropped, it is simply the next block's prefix.
 *
 * The cap's flag-day gate (CROSS_SETTLE_PER_BLOCK_CAP) lives in its own
 * suite, crossChainSettlementCapGate.test.js. Here the gate is simply ON, which
 * is its genesis state on regtest and testnet, so these keep testing the capped
 * behavior itself.
 */

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { getTestConfig } = require('../fixtures/config');
const Utility           = require('../../src/utility');
const Database          = require('../../src/db');
const PROTO             = require('../../src/protocol/constants.js');

function makeDb(){
    const config  = getTestConfig();
    const util    = new Utility();
    sinon.stub(util, 'logError');
    const indexer = { config, util };
    return new Database('127.0.0.1', 3306, 'xchain_btc_regtest', 'u', 'p', indexer);
}

// n finalized matches in the deterministic (snapshot_block, match_id) order the
// query returns them in.
function matches(n, from){
    const out = [];
    for(let i = (from || 0); i < (from || 0) + n; i++)
        out.push({ match_id: 'm' + String(i).padStart(4, '0'), snapshot_block: 1 });
    return out;
}

describe('cross-chain settlement per-block cap', function(){

    afterEach(() => sinon.restore());

    it('exports a cap alongside the XCALL and ATTEST siblings', function(){
        assert.strictEqual(typeof PROTO.CROSS_SETTLE_MAX_PER_BLOCK, 'number');
        assert.ok(PROTO.CROSS_SETTLE_MAX_PER_BLOCK > 0, 'a zero cap would stall settlement forever');
    });

    it('getEffectiveUnsettledMatches returns at most the cap, as the ordered prefix', async function(){
        const db  = makeDb();
        const all = matches(60);
        const doQuery = sinon.stub(db, 'doQuery');
        doQuery.onCall(0).resolves(all);   // mirror rows (_mirrorDb() === this here)
        doQuery.onCall(1).resolves([]);    // nothing settled locally yet

        const res = await db.getEffectiveUnsettledMatches('BTC', 1700, 25);
        assert.strictEqual(res.length, 25, 'the uncapped pass returned all 60');
        assert.deepStrictEqual(res.map(m => m.match_id), all.slice(0, 25).map(m => m.match_id),
            'the capped subset must be the ordered PREFIX, or two operators settle different matches');
    });

    it('defaults to a cap when the caller passes none, so no path is uncapped', async function(){
        const db = makeDb();
        const doQuery = sinon.stub(db, 'doQuery');
        doQuery.onCall(0).resolves(matches(60));
        doQuery.onCall(1).resolves([]);

        const res = await db.getEffectiveUnsettledMatches('BTC', 1700);
        assert.strictEqual(res.length, 25);
    });

    it('applies the cap AFTER the settled-set exclusion, so it counts real work', async function(){
        const db  = makeDb();
        const all = matches(40);
        const doQuery = sinon.stub(db, 'doQuery');
        doQuery.onCall(0).resolves(all);
        // The first 30 already settled: a cap applied in SQL before the exclusion would
        // return 10 fresh matches; applied after, it returns the full cap of fresh work.
        doQuery.onCall(1).resolves(all.slice(0, 30).map(m => ({ match_id: m.match_id })));

        const res = await db.getEffectiveUnsettledMatches('BTC', 1700, 25);
        assert.strictEqual(res.length, 10, 'only 10 unsettled matches exist');
        assert.deepStrictEqual(res.map(m => m.match_id), all.slice(30).map(m => m.match_id));
    });

    it('processCrossChainSettlements passes the protocol cap and carries the overflow forward', async function(){
        const util  = new Utility();
        const all   = matches(60);
        const seen  = [];
        let   asked = null;

        const db = {
            config: { COIN: 'BTC' },
            async getEffectiveUnsettledMatches(coin, block_time, limit){
                asked = limit;
                // Mirror the real method: exclude what previous blocks already settled,
                // then hand back the ordered prefix under the cap.
                const fresh = all.filter(m => !seen.includes(m.match_id));
                return fresh.slice(0, Number(limit) || 25);
            }
        };
        const actions = {
            // Gate ON: its genesis state on regtest/testnet.
            protocolChanges: { async isEnabled(){ return true; } },
            async processAction(name, _k, data){
                assert.strictEqual(name, 'CROSS_SETTLE');
                seen.push(data['MATCH'].match_id);
            }
        };

        await util.processCrossChainSettlements(actions, db, 100, 1700);
        assert.strictEqual(asked, PROTO.CROSS_SETTLE_MAX_PER_BLOCK, 'the pass must pass the protocol cap down');
        assert.strictEqual(seen.length, PROTO.CROSS_SETTLE_MAX_PER_BLOCK, 'one block must not settle the whole backlog');

        // Carry-forward: the remainder is not dropped, it is the next block's prefix.
        await util.processCrossChainSettlements(actions, db, 101, 1800);
        assert.strictEqual(seen.length, 2 * PROTO.CROSS_SETTLE_MAX_PER_BLOCK);
        assert.deepStrictEqual(seen, all.slice(0, 2 * PROTO.CROSS_SETTLE_MAX_PER_BLOCK).map(m => m.match_id),
            'settlement order across blocks stays the total (snapshot_block, match_id) order');
    });
});

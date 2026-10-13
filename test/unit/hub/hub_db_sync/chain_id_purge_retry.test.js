// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../../src/hub/hub_db_sync.js');

const CHAIN_NEW = '1a2b3c4d5e6f' + '0'.repeat(52);
const CHAIN_OLD = '9f8e7d6c5b4a' + 'f'.repeat(52);

const chainDels = (sql) => sql.filter((q) => /btc_chain_id IS NOT NULL AND btc_chain_id <> \?$/.test(q));

// A hub DB whose chain-id DELETEs behave per `mode()`: 'throw', 'empty' (collapsed to []) or ok.
function makeSync(mode) {
    const sql = [];
    const doQuery = sinon.stub().callsFake(async (q) => {
        sql.push(q);
        if (/^DELETE FROM /.test(q)) {
            const m = mode();
            if (m === 'throw') throw new Error('deadlock');
            if (m === 'empty') return [];
            return { affectedRows: 0 };
        }
        if (/^SELECT MAX\(id\)/.test(q)) return [{ max_id: null }];
        if (/^SELECT MAX\(effective_time\)/.test(q)) return [{ ts: null }];
        return [];
    });
    const sync = new HubDbSync({ doQuery }, { hubUrl: 'http://hub.test', network: 'regtest', coin: 'BTC' });
    return { sync, sql };
}

describe('HubDbSync chain-id purge retry @regression @tier2', function () {
    beforeEach(function () { sinon.stub(console, 'warn'); sinon.stub(console, 'log'); });
    afterEach(function () { sinon.restore(); });

    for (const failure of ['throw', 'empty']) {
        it('keeps the purge pending when a DELETE ' + failure + 's, and retries on a restated id', async function () {
            let mode = failure;
            const { sync, sql } = makeSync(() => mode);
            assert.strictEqual(await sync.setExpectedBtcChainId(CHAIN_NEW, 'hub'), true);
            assert.strictEqual(sync._chainIdPurgePending, true, 'a failed DELETE leaves the purge pending');
            const first = chainDels(sql).length;

            mode = 'ok';
            assert.strictEqual(await sync.setExpectedBtcChainId(CHAIN_NEW, 'hub'), false);
            assert.ok(chainDels(sql).length > first, 'the restated id retries the DELETEs');
            assert.strictEqual(sync._chainIdPurgePending, false, 'a clean retry clears the flag');

            const settled = sql.length;
            await sync.setExpectedBtcChainId(CHAIN_NEW, 'hub');
            assert.strictEqual(sql.length, settled, 'nothing is re-run once the purge is done');
        });
    }

    it('stays pending while the retry keeps failing', async function () {
        const { sync } = makeSync(() => 'throw');
        await sync.setExpectedBtcChainId(CHAIN_NEW, 'hub');
        await sync.setExpectedBtcChainId(CHAIN_NEW, 'hub');
        assert.strictEqual(sync._chainIdPurgePending, true);
    });

    it('still owes the legacy-table purge on retry after a chain change', async function () {
        let mode = 'ok';
        const { sync, sql } = makeSync(() => mode);
        await sync.setExpectedBtcChainId(CHAIN_OLD, 'hub');
        mode = 'throw';
        await sync.setExpectedBtcChainId(CHAIN_NEW, 'hub');
        const legacy = () => sql.filter((q) => /^DELETE FROM (state_checkpoints|anchor_reward_attestations)/.test(q)).length;
        const before = legacy();
        mode = 'ok';
        await sync.setExpectedBtcChainId(CHAIN_NEW, 'hub');
        assert.ok(legacy() > before, 'the retry re-runs the legacy purge');
        assert.strictEqual(sync._chainIdPurgePending, false);
    });
});

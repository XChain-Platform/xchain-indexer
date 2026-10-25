/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * Boot refusal for a consensus height gate moved into applied history.
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');

const Database = require('../../../../src/db');
const consensusRules = require('../../../../src/consensus_rules_digest.js');
const startup = require('../../../../src/XChainIndexer/startup.js');

const GATE = 'example_activation.EXAMPLE_ACTIVATION';

function fakeConnection(recorded){
    const state = { gateInserts: [], markers: [], commits: 0, rollbacks: 0, releases: 0 };
    const recordedBatch = recorded ? crypto.createHash('sha256')
        .update(consensusRules.canonical(recorded.gateHeights) + '\n' + String(recorded.appliedTip)).digest('hex') : null;
    return {
        state,
        async query(sql, params){
            if(sql.startsWith('SELECT data, witness_hash')){
                return recorded ? [{
                    data: JSON.stringify({ applied_tip: recorded.appliedTip,
                        count: Object.keys(recorded.gateHeights).length }),
                    witness_hash: recordedBatch
                }] : [];
            }
            if(sql.startsWith('SELECT data FROM events'))
                return Object.keys(recorded.gateHeights).sort().map(key => ({
                    data: JSON.stringify([key, recorded.gateHeights[key]])
                }));
            if(sql.startsWith('INSERT INTO events') && sql.includes("'CONSENSUS_GATE_HEIGHT'")) state.gateInserts.push(params);
            if(sql.startsWith('INSERT INTO events') && sql.includes("'CONSENSUS_GATE_BOOT'")) state.markers.push(params);
            if(sql === 'COMMIT') state.commits++;
            if(sql === 'ROLLBACK') state.rollbacks++;
            return [];
        },
        async release(){ state.releases++; }
    };
}

function bootFixture({ recorded, current, tip }){
    const conn = fakeConnection(recorded);
    let mirrorStarts = 0;
    const indexerDb = {
        transactionConnection: null,
        createDatabase: async () => true,
        verifyDatabase: async () => true,
        verifyTables: async () => true,
        runMigrations: async () => ({ lockSkipped: false }),
        getBlockIndex: async (component, type) => {
            assert.strictEqual(component, 'indexer');
            assert.strictEqual(type, 'last');
            return tip;
        },
        consensusHeightGateMap: () => current,
        getConnection: async () => conn,
        recordConsensusGateBoot: Database.prototype.recordConsensusGateBoot,
        warnOnOrphanIndexIds: async () => {},
        warnOnLegacyReorgCursor: async () => {}
    };
    const indexer = {
        config: { NETWORK: 'regtest', COIN: 'BTC' },
        indexerDbName: 'indexer',
        indexerDb,
        schemaReady: false,
        recordConsensusGateBoot: startup.recordConsensusGateBoot,
        checkDecoderReorgHalt: async () => {},
        resolveBtcChainId: async () => {},
        hubDbSync: { start: async () => { mirrorStarts++; } },
        util: { throwError(message){ throw new Error(message); } }
    };
    return {
        conn,
        indexer,
        mirrorStarts: () => mirrorStarts,
        run: async () => startup.verifyIndexerDatabase.call(indexer)
    };
}

describe('retroactive consensus gate move at boot @regression @tier1', function(){
    it('refuses to serve when a recorded gate moves to or below the applied tip', async function(){
        for(const movedHeight of [100, 99]){
            const fixture = bootFixture({
                recorded: { gateHeights: { [GATE]: 200 }, appliedTip: 90 },
                current: { [GATE]: movedHeight },
                tip: 100
            });

            await assert.rejects(fixture.run(), (error) => {
                assert.match(error.message, /moved at or below applied tip 100/);
                assert.match(error.message, new RegExp(GATE.replace('.', '\\.')));
                return true;
            });
            assert.strictEqual(fixture.indexer.schemaReady, false);
            assert.strictEqual(fixture.mirrorStarts(), 0, 'the mirror must not start after refusal');
            assert.strictEqual(fixture.conn.state.gateInserts.length, 0, 'the refused map must not replace the baseline');
            assert.strictEqual(fixture.conn.state.markers.length, 0, 'the refused tip must not replace the baseline');
            assert.strictEqual(fixture.conn.state.rollbacks, 1);
        }
    });

    it('refuses to serve when an applied gate moves above the tip or becomes inactive', async function(){
        for(const current of [
            { [GATE]: 101 },
            { [GATE]: consensusRules.FAR_FUTURE_HEIGHT_SENTINEL },
            { [GATE]: null },
            {}
        ]){
            const fixture = bootFixture({
                recorded: { gateHeights: { [GATE]: 99 }, appliedTip: 99 },
                current,
                tip: 100
            });

            await assert.rejects(fixture.run(), (error) => {
                assert.match(error.message, /moved at or below applied tip 100/);
                assert.match(error.message, new RegExp(GATE.replace('.', '\\.')));
                return true;
            });
            assert.strictEqual(fixture.indexer.schemaReady, false);
            assert.strictEqual(fixture.mirrorStarts(), 0, 'the mirror must not start after refusal');
            assert.strictEqual(fixture.conn.state.gateInserts.length, 0, 'the refused map must not replace the baseline');
            assert.strictEqual(fixture.conn.state.markers.length, 0, 'the refused tip must not replace the baseline');
            assert.strictEqual(fixture.conn.state.rollbacks, 1);
        }
    });

    it('serves and records the new map when the moved gate stays above the applied tip', async function(){
        const current = { [GATE]: 101 };
        const fixture = bootFixture({
            recorded: { gateHeights: { [GATE]: 200 }, appliedTip: 90 },
            current,
            tip: 100
        });

        await fixture.run();

        assert.strictEqual(fixture.indexer.schemaReady, true);
        assert.strictEqual(fixture.mirrorStarts(), 1, 'successful boot reaches the serving mirror');
        assert.strictEqual(fixture.conn.state.gateInserts.length, 1);
        assert.deepStrictEqual(JSON.parse(fixture.conn.state.gateInserts[0][0]), [GATE, 101]);
        assert.deepStrictEqual(JSON.parse(fixture.conn.state.markers[0][0]), { applied_tip: 100, count: 1, scope: 'registry' });
        assert.strictEqual(fixture.conn.state.gateInserts[0][1], fixture.conn.state.markers[0][1]);
        assert.strictEqual(fixture.conn.state.commits, 1);
        assert.strictEqual(fixture.conn.state.rollbacks, 0);
    });

    it('records the gate height map and null applied tip on an empty database', async function(){
        const current = { [GATE]: 0 };
        const fixture = bootFixture({ recorded: null, current, tip: null });

        await fixture.run();

        assert.deepStrictEqual(JSON.parse(fixture.conn.state.gateInserts[0][0]), [GATE, 0]);
        assert.deepStrictEqual(JSON.parse(fixture.conn.state.markers[0][0]), { applied_tip: null, count: 1, scope: 'registry' });
        assert.strictEqual(fixture.conn.state.commits, 1);
    });
});

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
 * Unit: /status reports when indexer schema startup has completed
 */

'use strict';

const assert = require('assert');

const startupMethods = require('../../../src/XChainIndexer/startup');
const XChainIndexer = require('../../../src/XChainIndexer');
const { statusBody } = require('../../../src/api/status_route');

function statusFor(schemaReady){
    const indexer = {
        schemaReady,
        stallReason: null,
        stallClearsAt: null,
        lastBlockCommittedAt: null,
        lastPollAt: null,
        isSynced: () => false
    };
    return statusBody({ atProcessableTip: () => false }, indexer, {
        indexerBlock: null,
        inFlightBlock: null,
        decoderBlock: null,
        verdict: {
            now: 1,
            stalled: false,
            wedged: false,
            futureWait: false,
            stallClass: 'none',
            lastHubConfigFetchAt: null,
            hubConfigAgeSeconds: null,
            hubConfigStale: false
        },
        hubMirror: { configured: false }
    });
}

function startupIndexer(runMigrations, expectedSchemaReadyDuringProbes = true){
    const indexer = {
        schemaReady: true,
        stopFlag: false,
        indexerDbName: 'indexer',
        indexerDb: {
            createDatabase: async () => true,
            verifyDatabase: async () => true,
            verifyTables: async () => true,
            runMigrations,
            warnOnOrphanIndexIds: async function(){
                assert.strictEqual(indexer.schemaReady, expectedSchemaReadyDuringProbes,
                    'readiness must reflect whether migrations acquired the lock');
            },
            warnOnLegacyReorgCursor: async () => {}
        },
        util: {
            throwError(message){ throw new Error(message); },
            sleep: async () => {}
        },
        checkDecoderReorgHalt: async () => {},
        resolveBtcChainId: async () => {},
        hubDbSync: null
    };
    return indexer;
}

describe('/status schemaReady', function(){
    it('always emits a boolean and reports true only for completed startup', function(){
        const bootingStatus = statusFor(undefined);
        assert.strictEqual(bootingStatus.schemaReady, false);
        assert.strictEqual(statusFor(false).schemaReady, false);
        assert.strictEqual(statusFor(true).schemaReady, true);
        const keys = Object.keys(bootingStatus);
        assert.deepStrictEqual(keys.slice(keys.indexOf('schemaReady'), keys.indexOf('schemaReady') + 4),
            ['schemaReady', 'train_activation', 'hubMirror', 'pollSilent']);
    });

    it('stays false through table verification and flips after migrations finish', async function(){
        let indexer, attempts = 0, sleeps = 0;
        indexer = startupIndexer(async () => {
            assert.strictEqual(indexer.schemaReady, false,
                'schema must not be ready while migrations are running');
            attempts++;
            return { lockSkipped: attempts < 3 };
        });
        indexer.util.sleep = async () => { sleeps++; };

        await startupMethods.verifyIndexerDatabase.call(indexer);
        assert.strictEqual(indexer.schemaReady, true);
        assert.strictEqual(attempts, 3);
        assert.strictEqual(sleeps, 2);
    });

    it('stays false when migrations are lock-skipped', async function(){
        let probes = 0;
        const indexer = startupIndexer(async () => ({ lockSkipped: true }), false);
        indexer.indexerDb.warnOnOrphanIndexIds = async () => { probes++; };
        indexer.util.sleep = async () => { indexer.stopFlag = true; };

        await startupMethods.verifyIndexerDatabase.call(indexer);
        assert.strictEqual(indexer.schemaReady, false);
        assert.strictEqual(probes, 0);

        for(const stopFlag of [false, true]){
            let background = 0, loop = 0;
            const boot = {
                name: 'test', version: '1', stopFlag: false,
                resolveRuntimeConfig(){}, createHubClients(){}, applyHubConfigOverlay: async () => {},
                startHubConfigPolling(){}, connectDatabases(){}, buildBlockModules(){},
                verifyDecoderDatabase: async () => {},
                verifyIndexerDatabase: async function(){ this.schemaReady = false; this.stopFlag = stopFlag; },
                startBackgroundServices(){ background++; }, runBlockLoop: async () => { loop++; }
            };
            if(stopFlag) await XChainIndexer.prototype.start.call(boot);
            else await assert.rejects(() => XChainIndexer.prototype.start.call(boot), /schema is not ready/);
            assert.strictEqual(background, 0);
            assert.strictEqual(loop, 0);
        }
    });

    it('stays false when migrations fail', async function(){
        const indexer = startupIndexer(async () => {
            throw new Error('migration failed');
        });

        await assert.rejects(
            startupMethods.verifyIndexerDatabase.call(indexer),
            /migration failed/
        );
        assert.strictEqual(indexer.schemaReady, false);
    });
});

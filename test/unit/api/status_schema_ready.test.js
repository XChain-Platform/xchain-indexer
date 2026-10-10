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
            throwError(message){ throw new Error(message); }
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
            ['schemaReady', 'hubMirror', 'pollSilent', 'lastPollAt']);
    });

    it('stays false through table verification and flips after migrations finish', async function(){
        let indexer;
        indexer = startupIndexer(async () => {
            assert.strictEqual(indexer.schemaReady, false,
                'schema must not be ready while migrations are running');
            return { lockSkipped: false };
        });

        await startupMethods.verifyIndexerDatabase.call(indexer);
        assert.strictEqual(indexer.schemaReady, true);
    });

    it('stays false when migrations are lock-skipped', async function(){
        const indexer = startupIndexer(
            async () => ({ lockSkipped: true }),
            false
        );

        await startupMethods.verifyIndexerDatabase.call(indexer);
        assert.strictEqual(indexer.schemaReady, false);
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

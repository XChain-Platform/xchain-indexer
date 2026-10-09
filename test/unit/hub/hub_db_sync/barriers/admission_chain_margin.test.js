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
 ********************************************************************/

'use strict';

process.env.XC_MIRROR_ADMISSION_ACTIVATION = '0';
process.env.INDEXER_COIN = 'DOGE';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');
const directCallPresence = require('../../../../../src/XChainIndexer/direct_call_presence.js');

function makeSync(coin, heights){
    const sync = new HubDbSync({ doQuery: async () => [] }, {
        hubUrl: 'http://hub.test', coin, network: 'regtest'
    });
    sync.heightWatermarks = heights;
    return sync;
}

describe('mirror admission barriers use chain-specific consumer targets', function(){
    it('clears DOGE at B minus 14 while LTC keeps the legacy margin', function(){
        const heights = { bridge_transfers: { DOGE: 986, LTC: 986 } };
        const doge = makeSync('DOGE', heights);
        const ltc = makeSync('LTC', heights);

        assert.strictEqual(doge.heightSatisfied('bridge_transfers', 1000), true);
        assert.strictEqual(doge.heightSatisfied('bridge_transfers', 1001), false);
        assert.strictEqual(ltc.heightSatisfied('bridge_transfers', 1000), false);
    });

    it('uses the DOGE price-snapshot margin of 16', function(){
        const sync = makeSync('DOGE', { price_snapshots: { DOGE: 984 } });
        assert.strictEqual(sync.heightSatisfied('price_snapshots', 1000), true);
        assert.strictEqual(sync.heightSatisfied('price_snapshots', 1001), false);
    });

    it('records, reports, and reconciles the selected target', function(){
        const sync = makeSync('DOGE', { bridge_transfers: { DOGE: 985 } });
        assert.strictEqual(sync.heightSatisfied('bridge_transfers', 1000), false);
        assert.strictEqual(sync._heightShortfalls['bridge_transfers|DOGE'], 986);
        assert.strictEqual(sync.heightTail('bridge_transfers', 1000),
            ' (admission height bridge_transfers.DOGE at 985, needs 986)');

        sync.heightWatermarks = { bridge_transfers: { DOGE: 986 } };
        sync.reconcileHeightShortfalls();
        assert.strictEqual(sync.heightsShort(), false);
    });

    it('uses the same DOGE target in the direct-hub call-presence barrier', async function(){
        const reads = [];
        const self = {
            hubDb: {
                getHubConfigParam: async (...args) => {
                    reads.push(args);
                    return [{ param_value: '986' }];
                }
            },
            config: { COIN: 'DOGE', NETWORK: 'regtest' },
            callPresenceTimeoutMs: 10,
            directCallGraceS: 120,
            mirrorAdmissionActiveAt: () => true,
            util: {
                sleep: async () => {},
                throwError: (message) => { throw new Error(message); }
            }
        };

        await directCallPresence.waitForDirectCallPresence.call(self, 2000, 1000);
        assert.deepStrictEqual(reads[0], [
            'xchain', 'regtest', 'admission_watermark', 'cross_chain_calls.DOGE'
        ]);
    });
});

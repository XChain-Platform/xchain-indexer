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
 *
 * Off-BTC retroactive targets use the covering checkpoint's BTC snapshot
 * block when checking capability mirror coverage.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const {
    capabilityMirrorTarget,
    runBootReplay,
} = require('../../../../src/consensus/retroactive/boot_replay.js');
const { mirrorCoverageGap } = require('../../../../src/consensus/retroactive/mirror_coverage.js');

const MOVABLE = 'movable_activation.MOVABLE_ACTIVATION';
const RECORDED = { [MOVABLE]: 200 };
const CURRENT = { [MOVABLE]: 95 };

function harness(chain, checkpoint){
    const calls = [];
    const deps = {
        readBoot: async () => ({
            recorded: { gateHeights: RECORDED, appliedTip: 100, scope: 'registry' },
            replayMarker: null,
        }),
        readCoveringCheckpoint: async (coin, target) => {
            calls.push(['readCoveringCheckpoint', coin, target]);
            return checkpoint;
        },
        readMirrorGap: async (target, requiredCapabilityBlock) => {
            calls.push(['readMirrorGap', target, requiredCapabilityBlock]);
            return mirrorCoverageGap({
                targetBlockTime: 1000000,
                fiatWindowSeconds: 3600,
                oldestPriceRoundTime: 900000,
                requiredCapabilityBlock,
                oldestCapabilitySnapshotBlock: requiredCapabilityBlock + 1,
            });
        },
        goMatches: async () => false,
        recordBoot: async () => calls.push(['recordBoot']),
        recordMarker: async () => calls.push(['recordMarker']),
        rollback: async () => calls.push(['rollback']),
        holdReplay: () => calls.push(['holdReplay']),
        holdNeedsGo: () => calls.push(['holdNeedsGo']),
        refuse: (reason) => { throw new Error(reason); },
    };
    const run = () => runBootReplay({
        tip: 100,
        current: CURRENT,
        capBlocks: 10,
        movableGates: [MOVABLE],
        chain,
    }, deps);
    return { calls, run };
}

describe('boot replay capability mirror target @regression @tier1', function(){

    for(const row of [
        { chain: 'LTC', block: 96, snapshot: 810000 },
        { chain: 'DOGE', block: 101, snapshot: 810100 },
    ]){
        it('maps a ' + row.chain + ' target to its covering BTC snapshot and checks the gap', async function(){
            const h = harness(row.chain, {
                chain: row.chain,
                block_index: row.block,
                snapshot_block: row.snapshot,
            });

            await assert.rejects(h.run(), new RegExp(
                'retroactive replay refused: mirror_gap: capability_snapshot_horizon:' +
                String(row.snapshot + 1) + '>' + String(row.snapshot)
            ));
            assert.deepStrictEqual(h.calls, [
                ['readCoveringCheckpoint', row.chain, 95],
                ['readMirrorGap', 95, row.snapshot],
            ]);
        });
    }

    it('uses the BTC target directly without reading a covering checkpoint', function(){
        assert.strictEqual(capabilityMirrorTarget('BTC', 95, null), 95);
    });

    it('refuses an absent or non-covering off-BTC checkpoint', async function(){
        const missing = harness('LTC', null);
        await assert.rejects(missing.run(),
            /mirror_gap: capability_snapshot_target_missing:LTC:95/);
        assert.deepStrictEqual(missing.calls, [
            ['readCoveringCheckpoint', 'LTC', 95],
        ]);

        const stale = harness('DOGE', {
            chain: 'DOGE',
            block_index: 94,
            snapshot_block: 810000,
        });
        await assert.rejects(stale.run(), /covering checkpoint must cover the replay target/);
        assert.deepStrictEqual(stale.calls, [
            ['readCoveringCheckpoint', 'DOGE', 95],
        ]);
    });
});

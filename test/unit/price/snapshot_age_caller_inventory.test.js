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
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO = path.join(__dirname, '../../..');
const SNAPSHOT = require(path.join(REPO, 'src/db/prices/oracle_vm_snapshot.js'));

function walkJavaScript(dir){
    const files = [];
    for(const entry of fs.readdirSync(dir, { withFileTypes: true })){
        const absolute = path.join(dir, entry.name);
        if(entry.isDirectory()) files.push(...walkJavaScript(absolute));
        else if(entry.name.endsWith('.js')) files.push(absolute);
    }
    return files;
}

// Mainnet, where the seconds basis is not armed: the age is still a block count.
async function snapshotAgeFor(latestBlock){
    const db = {
        config: { NETWORK: 'mainnet', COIN: 'BTC' },
        assertPriceBarrierNotSkipped(){},
        async doQueryStrict(query){
            if(/MAX\(reference_block\)/i.test(query)) return [{ latest_block: latestBlock }];
            return [];
        }
    };
    const loaded = await SNAPSHOT.getOracleDataForVM.call(db, 100, 0, 0);
    return loaded.snapshotAge;
}

describe('snapshot-age caller inventory @regression @tier1', function () {
    it('pins every source file that refers to snapshot age', function () {
        const callers = walkJavaScript(path.join(REPO, 'src'))
            .filter(file => /snapshotAge/i.test(fs.readFileSync(file, 'utf8')))
            .map(file => path.relative(REPO, file).split(path.sep).join('/'))
            .sort();

        assert.deepStrictEqual(callers, [
            'src/db/prices/oracle_preload_causality_gate.js',
            'src/db/prices/oracle_snapshot_age_seconds.js',
            'src/db/prices/oracle_vm_snapshot.js'
        ], 'A new snapshot-age caller must be added to the consensus-seconds migration as well as to this list.');
    });

    it('pins the current snapshot age to a block-count difference', async function () {
        assert.strictEqual(await snapshotAgeFor(90), 10);
        assert.strictEqual(await snapshotAgeFor(null), Number.MAX_SAFE_INTEGER);
    });
});

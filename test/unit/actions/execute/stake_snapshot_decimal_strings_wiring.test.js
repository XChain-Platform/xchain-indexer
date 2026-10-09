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
 ********************************************************************/

'use strict';

const assert = require('assert');
const sinon = require('sinon');

const Execute = require('../../../../src/actions/execute/index.js');
const { makeVm, executeData, buildExecute } = require('../execute.test/helpers/fixture.js');

afterEach(function () { sinon.restore(); });

describe('STAKE_SNAPSHOT_DECIMAL_STRINGS EXECUTE wiring @regression @tier1', function () {
    for(const active of [true, false]) {
        it('passes the activation verdict ' + active + ' into the snapshot handed to the VM', async function () {
            const { indexer, actionsCtx } = buildExecute();
            const contractStakeData = { stakeByPubkeyTick: {}, totalByTick: {}, stakersByTick: {} };
            const isEnabled = sinon.stub().callsFake(async name =>
                name === 'STAKE_SNAPSHOT_DECIMAL_STRINGS' ? active : true);
            actionsCtx.protocolChanges.isEnabled = isEnabled;
            actionsCtx.vm = makeVm();
            indexer.indexerDb.getContractStakeDataForVM.resolves(contractStakeData);
            const handler = new Execute(actionsCtx);

            await handler.parse(['0', '5', 'transfer', 'recipient', '50'], executeData({ BLOCK_INDEX: 100 }), null);

            assert.ok(isEnabled.calledWith('STAKE_SNAPSHOT_DECIMAL_STRINGS', 100));
            const snapshotArgs = indexer.indexerDb.getContractStakeDataForVM.firstCall.args;
            assert.strictEqual(snapshotArgs[1], 100);
            assert.strictEqual(snapshotArgs[2], true);
            assert.strictEqual(snapshotArgs[3], active);
            assert.strictEqual(actionsCtx.vm.execute.firstCall.args[0].contractStakeData, contractStakeData);
        });
    }
});

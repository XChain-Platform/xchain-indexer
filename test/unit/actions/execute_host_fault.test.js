/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * EXECUTE host-fault propagation — halt-vs-fabricate (consensus).
 *
 * When the out-of-process VM executor is permanently broken (worker can never
 * start: fork EAGAIN, isolated-vm load failure) it REJECTS with a HostFaultError
 * (code EXECUTOR_UNAVAILABLE) rather than fabricating an out_of_resource result.
 * The EXECUTE handler must NOT swallow that into a committed status — it must let
 * it propagate so the block loop (XChainIndexer.js) HALTS and retries instead of
 * committing a fabricated result that would diverge this node's contract_hash and
 * fork it off the fleet. This pins that propagation contract.
 ********************************************************************/

const assert = require('assert');
const sinon  = require('sinon');
const { createMockIndexer, createBaseData } = require('../../fixtures/mocks');
const { getTestConfig } = require('../../fixtures/config');
const Execute = require('../../../src/actions/execute.js');

// Mirror of xchain-vm HostFaultError (we don't depend on xchain-vm here).
class HostFaultError extends Error {
    constructor(reason) { super(reason || 'executor unavailable'); this.name = 'HostFaultError'; this.code = 'EXECUTOR_UNAVAILABLE'; }
}

describe('EXECUTE host-fault propagation — halt, not fabricate @regression @tier1', function () {

    function buildHandler(vmExecute) {
        const config = getTestConfig();
        config['GAS_PRICE'] = '0'; // fee = 0 → skip the fee/balance validation path
        const indexer = createMockIndexer({ config });

        const db = indexer.indexerDb;
        db.getContract             = sinon.stub().resolves({ code: 'module.exports=function(){return 1;};', status_id: 7 });
        db.getStatusString         = sinon.stub().resolves('valid');
        db.getTokenInfo            = sinon.stub().resolves({ TICK_ID: 1 });
        db.getAddressBalances      = sinon.stub().resolves({});
        db.isActionAllowed         = sinon.stub().resolves(true);
        db.getContractState        = sinon.stub().resolves({});
        db.getOracleDataForVM      = sinon.stub().resolves({});
        db.getCrossChainDataForVM  = sinon.stub().resolves({});
        db.getContractStakeDataForVM = sinon.stub().resolves({});
        // If the handler ever reached commit (it must NOT on a host fault), surface it:
        db.createContractExecution = sinon.stub().rejects(new Error('reached commit — host fault was swallowed!'));

        indexer.vm    = { execute: vmExecute };
        indexer.hubDb = null;
        return new Execute(indexer);
    }

    const data = () => createBaseData({ ACTION: 'EXECUTE', CONTRACT_ACTION_INDEX: 5, METHOD: 'default' });
    const params = ['EXECUTE', '5', 'default'];

    it('propagates a HostFaultError from the VM (does not commit/fabricate)', async function () {
        const handler = buildHandler(sinon.stub().rejects(new HostFaultError('executor unavailable')));
        await assert.rejects(
            handler.parse(params, data(), null),
            (e) => e && e.code === 'EXECUTOR_UNAVAILABLE',
            'EXECUTE must let a host fault propagate so the block loop halts'
        );
    });

    it('still COMMITS for a normal VM failure result (fabricate path unchanged)', async function () {
        // A genuine resource exhaustion is a deterministic contract outcome — the
        // handler must record it and advance, NOT halt. (Sanity that the propagation
        // branch is scoped to host faults only.)
        const handler = buildHandler(sinon.stub().resolves({
            success: false, error: 'out_of_resource: ...', gasUsed: 1000000,
            returnValue: null, stateChanges: [], stateDeletes: [], emittedActions: [], logs: []
        }));
        // createContractExecution is stubbed to throw on commit; a normal failure
        // result reaches commit, so we assert it got THAT far (not a host-fault halt).
        await assert.rejects(
            handler.parse(params, data(), null),
            (e) => /reached commit/.test(e.message),
            'a normal VM failure must proceed to commit, not propagate as a host fault'
        );
    });
});

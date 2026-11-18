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
 * test/unit/action_dispatch/file_part_preflight_unjudged.test.js
 *
 * The synthetic dry-run transaction carries no payload bytes, so a well-formed FILE part
 * always draws the handler's empty-part refusal there. The quote surfaces answer that one
 * status as unjudged (valid null) and keep every other refusal, while the handler's own
 * verdict, the one the chain records, is unchanged.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');

const { createBaseData } = require('../../fixtures/mocks');
const { buildFile } = require('../actions/contract/file.test/helpers/fixture.js');
const File = require('../../../src/actions/file.js');
const { EMPTY_PART_ERROR } = require('../../../src/actions/file_multipart_validate.js');
const { dryRunOutcome } = require('../../../src/actions/actions_class/dry_run_support.js');
const { preflightResult, dryRunVerdictQuote } = require('../../../src/actions/actions_class/quote_answers.js');
const feeViews = require('../../../src/actions/actions_class/fee_views.js');

const SOURCE    = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';
const FILE_HASH = 'a'.repeat(64);

async function partStatus(params, raw){
    const built = buildFile();
    built.actionsCtx.protocolChanges.isEnabled = sinon.stub().resolves(true);
    built.indexer.indexerDb.createPart = sinon.stub().resolves();
    built.indexer.indexerDb.getGroup = sinon.stub().resolves({ manifest: null, parts: [] });
    built.indexer.indexerDb.isActionAllowed.resolves(true);
    const data = createBaseData({ ACTION: 'FILE', FORMAT: 2, SOURCE });
    data['RAW_DATA'] = raw;
    await new File(built.actionsCtx).parse(params, data, null);
    return { status: data['STATUS'], built };
}

function runWith(status){
    return dryRunOutcome(100, 1000, { status, subCommands: undefined, legs: undefined }, null, null);
}

describe('FILE part quote surfaces without payload bytes @regression @tier1', function () {
    afterEach(function () { sinon.restore(); });

    it('the handler still refuses a part with no bytes, so the chain verdict is unchanged', async function () {
        const { status } = await partStatus(['2', FILE_HASH, '0'], null);
        assert.strictEqual(status, EMPTY_PART_ERROR);
        const filled = await partStatus(['2', FILE_HASH, '0'], Buffer.from('abc'));
        assert.strictEqual(filled.status, 'valid');
    });

    it('pre-flight answers the empty-part status as unjudged, not invalid', async function () {
        const { status, built } = await partStatus(['2', FILE_HASH, '0'], null);
        const answer = preflightResult(built.actionsCtx, { action: 'FILE' }, runWith(status), 'xchain', 'XCHAIN');
        assert.strictEqual(answer.valid, null);
        assert.strictEqual(answer.status, null);
        assert.strictEqual(answer.error, null);
        assert.strictEqual(answer.payloadUnjudged, true);
    });

    it('pre-flight keeps every refusal the dry-run can judge', async function () {
        const hashRefused = await partStatus(['2', 'xyz', '0'], null);
        assert.strictEqual(hashRefused.status, 'invalid: FILE_HASH (format)');
        const answer = preflightResult(hashRefused.built.actionsCtx, { action: 'FILE' },
            runWith(hashRefused.status), 'xchain', 'XCHAIN');
        assert.strictEqual(answer.valid, false);
        assert.strictEqual(answer.error, 'invalid: FILE_HASH (format)');
        assert.strictEqual(answer.payloadUnjudged, undefined);

        const indexRefused = await partStatus(['2', FILE_HASH, '999999'], null);
        assert.strictEqual(indexRefused.status, 'invalid: PART_INDEX (range)');
    });

    it('the same status on another action is still a refusal', function () {
        const answer = preflightResult({ util: { isGuardInertError: () => false, bcformat: (v) => v,
            bcnum: (v) => v, bcgte: () => true } }, { action: 'MESSAGE' }, runWith(EMPTY_PART_ERROR), 'xchain', 'XCHAIN');
        assert.strictEqual(answer.valid, false);
    });

    it('fee quote returns an unpriced unjudged answer for the empty-part status only', function () {
        const util = { isGuardInertError: () => false };
        const unjudged = dryRunVerdictQuote({ util }, { status: EMPTY_PART_ERROR, validated: true }, runWith(EMPTY_PART_ERROR), 'FILE');
        assert.strictEqual(unjudged.valid, null);
        assert.strictEqual(unjudged.payloadUnjudged, true);
        assert.strictEqual(unjudged.validated, false);
        assert.strictEqual(unjudged.xchainFee, null);

        const refused = dryRunVerdictQuote({ util }, {}, runWith('invalid: PART_INDEX (range)'), 'FILE');
        assert.strictEqual(refused.valid, false);
        assert.strictEqual(dryRunVerdictQuote({ util }, {}, runWith('valid'), 'FILE'), null);
    });

    it('the raw dry-run RPC answers the empty-part status as unjudged', async function () {
        const ctx = {
            actionAliases: {},
            config: { COIN: 'BTC', ADDRESS: {}, BLOCK_PROCESS_TIMEOUT: 1000 },
            util: { bcformat: (v) => v, bcnum: (v) => v },
            dryRunAction: async () => runWith(EMPTY_PART_ERROR)
        };
        const answer = await feeViews.computeFeeQuoteDryRun.call(ctx,
            { action: 'FILE', params: ['2', FILE_HASH, '0'], source: SOURCE });
        assert.strictEqual(answer.valid, null);
        assert.strictEqual(answer.status, null);
        assert.strictEqual(answer.payloadUnjudged, true);
    });
});

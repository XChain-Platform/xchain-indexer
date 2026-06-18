'use strict';

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
 **********************************************************************
 * Controller-bound token: retirement of the Phase-1 single-column model.
 *
 * The original feature bolted a single CONTROLLER / LOCK_CONTROLLER pair onto the
 * full ISSUE format (and the tokens/issues tables). That model was superseded by
 * the append-only token_controllers / address_controllers tables (per-action-class,
 * always-droppable with a read-time cooldown; see controller-policy-layer.test.js).
 * These tests pin the RETIREMENT: the permanent-lock and the single-column wire
 * fields are gone, while the reusable guard engine (runControllerGuard +
 * VM_GUARD_GAS_CEILING) remains. Pure (no DB/VM) so they run on any Node version.
 *
 * Spec: xchain-documentation/protocol/Controller_Bound_Tokens.md
 ********************************************************************/

const assert = require('assert');

const Issue   = require('../../src/actions/issue.js');
const Execute = require('../../src/actions/execute.js');

const STUB = { config: {}, decoderDb: null, indexerDb: null, util: null, mapper: null };

describe('Controller-bound token: Phase-1 single-column model retired @regression', function () {

    const issue = new Issue(STUB);

    describe('the permanent-lock (LOCK_CONTROLLER) is gone everywhere', function () {
        it('no ISSUE format string mentions LOCK_CONTROLLER', function () {
            for (const [v, fmt] of Object.entries(issue.formats))
                assert.ok(!fmt.split('|').includes('LOCK_CONTROLLER'),
                    `format ${v} must not carry LOCK_CONTROLLER (no permanent lock)`);
        });

        it('LOCK_CONTROLLER is not in the Issue handler LOCK field list', function () {
            assert.ok(!issue.fieldList['LOCK'].includes('LOCK_CONTROLLER'));
        });

        it('LOCK_CONTROLLER is not a config LOCK field', function () {
            process.env.INDEXER_COIN = 'BTC';
            process.env.INDEXER_NETWORK = 'regtest';
            delete require.cache[require.resolve('../../src/config.js')];
            const config = require('../../src/config.js').getConfig();
            assert.ok(!config.LOCK_FIELDS.includes('LOCK_CONTROLLER'));
        });
    });

    describe('the single-column CONTROLLER no longer rides the token-edit formats', function () {
        it('ISSUE format 0 (full) does not carry CONTROLLER', function () {
            assert.ok(!issue.formats[0].split('|').includes('CONTROLLER'),
                'format 0 must not carry the controller binding: that is format 6 only now');
        });

        it('CONTROLLER lives only on the dedicated binding format (6)', function () {
            const carriers = Object.entries(issue.formats)
                .filter(([, fmt]) => fmt.split('|').includes('CONTROLLER'))
                .map(([v]) => Number(v));
            assert.deepStrictEqual(carriers, [6]);
        });
    });

    describe('the reusable guard engine is retained', function () {
        it('Execute still exposes runControllerGuard', function () {
            const exec = new Execute(Object.assign({}, STUB, { config: {} }));
            assert.strictEqual(typeof exec.runControllerGuard, 'function');
        });

        it('the per-chain gas schedule still defines VM_GUARD_GAS_CEILING', function () {
            process.env.INDEXER_COIN = 'BTC';
            process.env.INDEXER_NETWORK = 'regtest';
            delete require.cache[require.resolve('../../src/config.js')];
            const config = require('../../src/config.js').getConfig();
            assert.ok(Number.isInteger(config.GAS_SCHEDULE.VM_GUARD_GAS_CEILING));
            assert.ok(config.GAS_SCHEDULE.VM_GUARD_GAS_CEILING > 0);
        });
    });
});

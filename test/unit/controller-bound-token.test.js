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
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Controller-bound token — binding wire contract (Phase 1).
 *
 * A token may bind a CONTROLLER (a deployed contract's action_index) whose
 * `guard` method gates guarded native actions. These tests pin the wire/field
 * contract for that binding (ISSUE formats + field lists + config), and assert
 * the guard engine surface exists. They are PURE: handlers are built with a stub
 * context (no DB, no VM), so they run on any Node version — the guard's runtime
 * behavior is exercised by the e2e suite on a live regtest stack (Node 22).
 *
 * Spec: xchain-documentation/protocol/Controller_Bound_Tokens.md
 ********************************************************************/

const assert = require('assert');
const path   = require('path');

const Issue   = require('../../src/actions/issue.js');
const Execute = require('../../src/actions/execute.js');

const STUB = { config: {}, decoderDb: null, indexerDb: null, util: null, mapper: null };

describe('Controller-bound token — binding wire contract @regression', function () {

    const issue = new Issue(STUB);

    describe('ISSUE format templates carry CONTROLLER / LOCK_CONTROLLER', function () {
        it('v0 (full) appends CONTROLLER|LOCK_CONTROLLER before MEMO', function () {
            const tokens = issue.formats[0].split('|');
            assert.ok(tokens.includes('CONTROLLER'), 'v0 missing CONTROLLER');
            assert.ok(tokens.includes('LOCK_CONTROLLER'), 'v0 missing LOCK_CONTROLLER');
            // MEMO stays terminal; CONTROLLER/LOCK_CONTROLLER sit just before it.
            assert.strictEqual(tokens[tokens.length - 1], 'MEMO', 'v0 MEMO must stay last');
            assert.strictEqual(tokens[tokens.length - 2], 'LOCK_CONTROLLER');
            assert.strictEqual(tokens[tokens.length - 3], 'CONTROLLER');
        });

        it('v3 (edit LOCK params) includes LOCK_CONTROLLER', function () {
            assert.ok(issue.formats[3].split('|').includes('LOCK_CONTROLLER'), 'v3 missing LOCK_CONTROLLER');
        });

        it('v6 (edit CONTROLLER params) has the exact layout', function () {
            assert.strictEqual(issue.formats[6], 'VERSION|TICK|CONTROLLER|LOCK_CONTROLLER|MEMO');
        });

        it('v6 wire string round-trips through split/join', function () {
            const wire = '6|JDOG|12345|1|note';
            assert.deepStrictEqual(String(wire).split('|'), ['6', 'JDOG', '12345', '1', 'note']);
            assert.strictEqual(issue.formats[6].split('|').length, String(wire).split('|').length);
        });
    });

    describe('LOCK_CONTROLLER follows the existing LOCK_* enforcement loop', function () {
        it('is listed in the Issue handler LOCK field list', function () {
            assert.ok(Array.isArray(issue.fieldList['LOCK']));
            assert.ok(issue.fieldList['LOCK'].includes('LOCK_CONTROLLER'),
                'LOCK_CONTROLLER must be in fieldList.LOCK so it cannot be un-locked');
        });
    });

    describe('config field classification', function () {
        let config;
        before(function () {
            process.env.INDEXER_COIN = 'BTC';
            process.env.INDEXER_NETWORK = 'regtest';
            delete require.cache[require.resolve('../../src/config.js')];
            config = require('../../src/config.js').getConfig();
        });

        it('CONTROLLER is a NUMBER field (it is a contract action_index)', function () {
            assert.ok(config.NUMBER_FIELDS.includes('CONTROLLER'));
        });

        it('LOCK_CONTROLLER is a LOCK field', function () {
            assert.ok(config.LOCK_FIELDS.includes('LOCK_CONTROLLER'));
        });

        it('the per-chain gas schedule defines VM_GUARD_GAS_CEILING', function () {
            assert.ok(Number.isInteger(config.GAS_SCHEDULE.VM_GUARD_GAS_CEILING),
                'VM_GUARD_GAS_CEILING must be an integer ceiling for guard runs');
            assert.ok(config.GAS_SCHEDULE.VM_GUARD_GAS_CEILING > 0);
        });
    });

    describe('guard engine surface', function () {
        it('Execute exposes runControllerGuard', function () {
            const exec = new Execute(Object.assign({}, STUB, { config: {} }));
            assert.strictEqual(typeof exec.runControllerGuard, 'function');
        });
    });
});

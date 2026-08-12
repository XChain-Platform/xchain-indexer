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
 * Programmable policy layer: Phase A binding wire contract.
 *
 * The table model (token_controllers / address_controllers) routes ONE action-class
 * per action to a guard contract. These tests pin the wire/field contract for that
 * binding: ISSUE format 7, ADDRESS format 1, the action-class taxonomy, and the field
 * classifications the handlers rely on. They are PURE: handlers are built with a stub
 * context (no DB, no VM) so they run on any Node version. The db-layer bind/unbind/
 * cooldown-sweep behavior is consensus-critical and exercised on Node 22 / regtest
 * (this Mac is Node 24, where isolated-vm / mariadb cannot load).
 *
 * Spec: xchain-documentation/protocol/Controller_Bound_Tokens.md
 ********************************************************************/

const assert = require('assert');

const Issue   = require('../../src/actions/issue.js');
const Address = require('../../src/actions/address.js');

const STUB = { config: {}, decoderDb: null, indexerDb: null, util: null, mapper: null };

describe('Programmable policy layer : Phase A binding wire contract @regression', function () {

    const issue   = new Issue(STUB);
    const address = new Address(STUB);

    describe('ISSUE format 6 : token controller bind/unbind', function () {
        it('has the exact one-binding-per-action layout', function () {
            assert.strictEqual(issue.formats[6], 'VERSION|TICK|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO');
        });

        it('MEMO stays terminal', function () {
            const tokens = issue.formats[6].split('|');
            assert.strictEqual(tokens[tokens.length - 1], 'MEMO');
        });

        it('a bind wire string round-trips through split/join', function () {
            // bind contract #12345 to the `trade` class with a 100-block drop-cooldown
            const wire = '6|JDOG|12345|trade|100|0|note';
            const parts = String(wire).split('|');
            assert.strictEqual(parts.length, issue.formats[6].split('|').length);
            assert.deepStrictEqual(parts, ['6', 'JDOG', '12345', 'trade', '100', '0', 'note']);
        });

        it('an unbind wire string leaves CONTROLLER empty and sets UNBIND=1', function () {
            const wire = '6|JDOG||transfer|0|1|';
            assert.deepStrictEqual(String(wire).split('|'), ['6', 'JDOG', '', 'transfer', '0', '1', '']);
        });
    });

    describe('ADDRESS format 1 : self-gating controller bind/unbind', function () {
        it('has the exact layout (self-signed; no FEE/MEMO preferences)', function () {
            assert.strictEqual(address.formats[1], 'VERSION|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO');
        });

        it('keeps format 0 (preferences) intact', function () {
            assert.strictEqual(address.formats[0], 'VERSION|FEE_PREFERENCE|REQUIRE_MEMO|DISPENSER_PREFERENCE|MEMO');
        });

        it('a bind wire string round-trips through split/join', function () {
            const wire = '1|6789|transfer|0|0|note';
            const parts = String(wire).split('|');
            assert.strictEqual(parts.length, address.formats[1].split('|').length);
            assert.deepStrictEqual(parts, ['1', '6789', 'transfer', '0', '0', 'note']);
        });

        it('CONTROLLER/COOLDOWN_BLOCKS/UNBIND are NOT in the ADDRESS NUMBER list', function () {
            // The handler depends on these staying raw strings (so a contract action_index and an
            // integer block count map cleanly onto the BIGINT/INT columns without bignumber coercion).
            for (const field of ['CONTROLLER', 'COOLDOWN_BLOCKS', 'UNBIND']) {
                assert.ok(!address.fieldList['NUMBER'].includes(field),
                    `ADDRESS NUMBER list must not include ${field}`);
            }
        });
    });

    describe('config : action-class taxonomy + field classifications', function () {
        let config;
        before(function () {
            process.env.INDEXER_COIN = 'BTC';
            process.env.INDEXER_NETWORK = 'regtest';
            delete require.cache[require.resolve('../../src/config.js')];
            config = require('../../src/config.js').getConfig();
        });

        it('CONTROLLER_ACTION_CLASSES is exactly the six routable classes', function () {
            assert.deepStrictEqual(config.CONTROLLER_ACTION_CLASSES,
                ['transfer', 'trade', 'burn', 'mint', 'stake', 'ownership']);
        });

        it("CONTROLLER_BINDABLE_CLASSES is the six routable classes plus the catch-all 'all'", function () {
            assert.deepStrictEqual(config.CONTROLLER_BINDABLE_CLASSES,
                ['transfer', 'trade', 'burn', 'mint', 'stake', 'ownership', 'all']);
        });

        it("'all' is BINDABLE but never ROUTABLE", function () {
            assert.ok(config.CONTROLLER_BINDABLE_CLASSES.includes('all'));
            assert.ok(!config.CONTROLLER_ACTION_CLASSES.includes('all'));
        });

        it('COOLDOWN_BLOCKS is a NUMBER field', function () {
            assert.ok(config.NUMBER_FIELDS.includes('COOLDOWN_BLOCKS'));
        });

        it('UNBIND is a NUMBER field', function () {
            assert.ok(config.NUMBER_FIELDS.includes('UNBIND'));
        });

        it('CONTROLLER remains a NUMBER field (contract action_index)', function () {
            assert.ok(config.NUMBER_FIELDS.includes('CONTROLLER'));
        });
    });
});

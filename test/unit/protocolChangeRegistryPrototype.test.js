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
 **********************************************************************
 * test/unit/protocolChangeRegistryPrototype.test.js
 *
 * The protocol-change registry must not answer for names nobody registered.
 *
 * Every lookup in protocol_changes.js is a bare `this.changes[name]` where `name`
 * is an UNTRUSTED action name taken off the wire. While that map was a plain
 * object it inherited Object.prototype, so five names resolved to an inherited
 * member instead of to nothing:
 *
 *   - the member is truthy, so isEnabled() entered its `if(change)` branch;
 *   - every gate field on it is undefined, so every parseInt is NaN;
 *   - NaN fails every `>` comparison, so no time or block gate ever fired;
 *   - `enabled` therefore stayed TRUE, at any block, on any network.
 *
 * The consequence was not cosmetic. The indexer's BATCH activation scan calls
 * isEnabled() on each sub-command's action name to decide whether to reject the
 * whole batch, so `BATCH|0|constructor|0|x` PASSED the scan that an unregistered
 * name fails - and the decoder's whole-batch-rejection mirror keys on that same
 * rule. addChange() would also have refused a legitimately-named change as a
 * duplicate, because its uniqueness test is the same truthy lookup.
 *
 * The fix is Object.create(null) at construction, closing it at the source rather
 * than at each read site, so a sixth lookup added later cannot reintroduce it.
 * These tests are deliberately written against the PUBLIC surface (isDefined and
 * the registry itself) rather than against the constructor line, so they keep
 * their teeth if the implementation changes shape.
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');

const { createMockIndexer } = require('../fixtures/mocks');
const ProtocolChanges       = require('../../src/protocol_changes.js');

// Every name reachable on Object.prototype that an action name could spell.
// __proto__ is included deliberately: it is an accessor rather than a plain
// member, so it fails differently from the other four and a fix that handles
// only own-property lookups could still leave it live.
const PROTOTYPE_NAMES = [
    'constructor',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    '__proto__',
];

// Two real registrations, so a fix that broke the registry outright would be
// caught here rather than looking like a pass.
const REAL_CHANGES = ['BATCH_ISSUANCE_LIMITS', 'BATCH_SUBACTION_NORMALIZATION'];

function pcFor(network){
    const indexer = createMockIndexer();
    indexer.config.NETWORK = network;
    return new ProtocolChanges(indexer, '2.0.0');
}

describe('protocol-change registry is prototype-free @regression @tier1', function(){

    describe('the registry itself', function(){

        it('has a null prototype, so no inherited member is reachable by name', function(){
            const pc = pcFor('regtest');
            assert.strictEqual(
                Object.getPrototypeOf(pc.changes), null,
                'this.changes must be created with Object.create(null): a plain object lets an ' +
                'untrusted wire name resolve to an inherited member'
            );
        });

        it('still holds the real registrations', function(){
            const pc = pcFor('regtest');
            for(const name of REAL_CHANGES)
                assert.ok(pc.changes[name], name + ' must still be registered');
        });
    });

    describe('isDefined', function(){

        for(const name of PROTOTYPE_NAMES){
            it('answers false for the prototype member "' + name + '"', function(){
                const pc = pcFor('regtest');
                assert.strictEqual(
                    pc.isDefined(name), false,
                    '"' + name + '" is not a registered protocol change, so nothing may answer ' +
                    'for it: on a plain object it resolved to an inherited member and read as defined'
                );
            });
        }

        it('answers false for an ordinary unregistered name', function(){
            assert.strictEqual(pcFor('regtest').isDefined('NOPE_NOT_A_CHANGE'), false);
        });

        it('answers true for the real registrations', function(){
            const pc = pcFor('regtest');
            for(const name of REAL_CHANGES)
                assert.strictEqual(pc.isDefined(name), true, name + ' must read as defined');
        });
    });

    describe('every network, since the gate fields are what NaN out', function(){

        for(const network of ['mainnet', 'testnet', 'regtest']){
            it('resolves no prototype member on ' + network, function(){
                const pc = pcFor(network);
                for(const name of PROTOTYPE_NAMES)
                    assert.strictEqual(
                        pc.changes[name], undefined,
                        name + ' must resolve to undefined on ' + network
                    );
            });
        }
    });

    describe('addChange uniqueness is not confused by an inherited member', function(){

        it('accepts a change whose name collides with a prototype member', function(){
            const pc = pcFor('regtest');
            // Nothing registers such a name today, and nothing should; the point is that the
            // uniqueness guard must answer on what was REGISTERED, not on what was inherited.
            // On a plain object this threw "protocol change name must be unique!".
            assert.doesNotThrow(function(){
                pc.addChange('toString', '2.0.0', 0, 0, 0, 0, 0, 0);
            });
            assert.strictEqual(pc.isDefined('toString'), true,
                'once genuinely registered it must read as defined');
        });
    });
});

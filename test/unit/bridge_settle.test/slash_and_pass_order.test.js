/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The bridge engines as a slashable family, driven through the real SLASH handler, and
 * the pass position: policy snapshots at the head, ctx.proof cleared when the pass ends.
 * Part of the XBRIDGE settle pass suite; see ../bridge_settle.test.js for what these
 * tests are for and how the four guards are proven.
 *
 ********************************************************************/

'use strict';

const { BS, bindSettlementReads, NETWORK, SNAPSHOT, makeTransfer, makeCtx } = require('./helpers/settle_fixtures.js');
const assert = require('assert');
const eq     = require('../../../src/equivocation_header.js');
const Utility = require('../../../src/utility.js');

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('SLASH: the bridge engines are a slashable family', function(){
        // Driven through the real handler, not read off a map: ENGINE_CAPABILITY is
        // module-private, so the observable behaviour IS the test. The capability lookup sits
        // BEFORE the signature check in parse(), so a deliberately invalid signature is enough
        // to separate "mapped" from "not slashable" without building a real equivocation.
        function slashProbe(tag, roundId, contentA, contentB){
            const Slash = require('../../../src/actions/slash/index.js');
            const cfg   = { COIN: 'BTC', NETWORK: NETWORK, GAS: 'XCHAIN' };
            const s = new Slash({ config: cfg, decoderDb: {}, util: new Utility(cfg),
                                  mapper: { createMappings: async () => {} },
                                  indexerDb: { updateBalances: async () => {}, updateTokens: async () => {},
                                               createSlash: async () => {} } });
            const b64  = (x) => Buffer.from(x, 'utf8').toString('base64url');
            const a    = eq.buildEquivCanonical(tag, roundId, 0, contentA);
            const b    = eq.buildEquivCanonical(tag, roundId, 0, contentB);
            const data = { FORMAT: 0, COIN: 'BTC', BLOCK_INDEX: 100, ACTION: 'SLASH' };
            return s.parse([0, 'cross_chain', 'ab'.repeat(32), b64(a), 'ff'.repeat(64), b64(b), 'ee'.repeat(64)],
                           data, null)
                    .then(() => data['STATUS'], () => data['STATUS']);
        }

        it('maps XBRIDGE and XPOLICY to a capability, where an unmapped tag is refused', async function(){
            const control = await slashProbe(eq.ENGINE_TAGS.NODEPROOF, 'z', 'X|1', 'X|2');
            assert.strictEqual(control, 'invalid: ENGINE_TAG (not slashable)',
                'the control must stop AT the capability gate, or the cases below prove nothing');
            for(const tag of [eq.ENGINE_TAGS.BRIDGE, eq.ENGINE_TAGS.POLICY]){
                const got = await slashProbe(tag, 'a'.repeat(64), tag + '|a|1200|X', tag + '|a|1200|Y');
                assert.notStrictEqual(got, control, tag + ' is not a slashable family');
                assert.strictEqual(got, 'invalid: SIG_A (does not verify)',
                    tag + ' should reach the signature check, i.e. past the capability gate');
            }
        });

        it('resolves each bridge canonical slot from snapshot_block at field index 2', async function(){
            const Slash = require('../../../src/actions/slash/index.js');
            const cfg   = { COIN: 'BTC', NETWORK: NETWORK, GAS: 'XCHAIN' };
            const s = new Slash({ config: cfg, decoderDb: {}, indexerDb: {}, util: new Utility(cfg), mapper: {} });
            // Without a field entry this returns 'invalid: ENGINE_TAG (no snapshot_block rule)'
            // and the capability mapping above would be inert: a real forgery would burn nothing.
            assert.deepStrictEqual(
                await s.resolveSlot(eq.ENGINE_TAGS.BRIDGE, 'a'.repeat(64),
                                     'XBRIDGE|a|1200|X', 'XBRIDGE|a|1200|Y', false),
                { snapshotBlock: SNAPSHOT });
            assert.deepStrictEqual(
                await s.resolveSlot(eq.ENGINE_TAGS.POLICY, 'd'.repeat(64),
                                     'XPOLICY|d|1200|X', 'XPOLICY|d|1200|Y', false),
                { snapshotBlock: SNAPSHOT });
            // The two contents must agree on the height, or the pair names no shared slot.
            const mismatched = await s.resolveSlot(eq.ENGINE_TAGS.BRIDGE, 'a'.repeat(64),
                                                    'XBRIDGE|a|1200|X', 'XBRIDGE|a|1300|Y', false);
            assert.ok(mismatched.error, 'a height mismatch must not resolve a slot');
        });
    });
});

describe('bridge_settle: the XBRIDGE settle pass', function(){
    describe('SLASH: the bridge engines are a slashable family', function(){
        it('reads the height out of the canonical this module actually builds', function(){
            // The field index is only right if the canonical really carries snapshot_block
            // third. Read it back off the module's own builders rather than off a literal.
            const t = BS.transferCanonical(makeTransfer([], {}));
            const p = BS.policyCanonical({ snapshot_id: 'd'.repeat(64), snapshot_block: SNAPSHOT,
                                           origin_chain: 'BTC', tick: 'PEPECASH', policy_seq: 1,
                                           origin_block: 500, policy_hash: 'f'.repeat(64),
                                           effective_time: 1000, network: NETWORK, finalizing_view: 0 });
            const content = (wrapped) => wrapped.slice(wrapped.indexOf('||') + 2);
            assert.strictEqual(content(t).split('|')[2], String(SNAPSHOT));
            assert.strictEqual(content(p).split('|')[2], String(SNAPSHOT));
        });
    });

    describe('the pass position and ordering', function(){

        it('runs policy snapshots at the HEAD, before any transfer leg', async function(){
            const order = [];
            const { ctx } = makeCtx({ coin: 'DOGE' });
            ctx.indexerDb.mirrorDb = () => bindSettlementReads({ doQuery: async (sql) => {
                order.push(/policy_snapshots/.test(sql) ? 'policy' : 'transfer');
                return [];
            }});
            await BS.processBridgeSettlePass(ctx);
            assert.deepStrictEqual(order, ['policy', 'transfer'],
                'the membership a snapshot materializes gates the credits the transfer legs apply');
        });

        it('clears ctx.proof when the pass ends, so no row inherits another row proof', async function(){
            const { ctx } = makeCtx({ coin: 'DOGE' });
            ctx.proof = { stale: true };
            await BS.processBridgeSettlePass(ctx);
            assert.strictEqual('proof' in ctx, false);
        });
    });
});

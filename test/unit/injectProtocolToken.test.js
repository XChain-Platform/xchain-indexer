// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The shared protocol-token creation helper and the bridged root/child rows it builds:
// the base bridge spec row 4 and section 9, the token bridge spec
// row 4 and section 6.
//
// What these cases hold, and why each one is consensus and not housekeeping:
//   - the ISSUE format 0 field ORDER and the trailing-field trim, because the wire string is
//     what the handler parses and what enters actions_hash;
//   - the synthetic tx hash per family, because it is the transaction identity a reindex
//     must reproduce and two injections may never collide on it;
//   - the existing-row rules of section 6 (a root owned by a squatter, and the decimals
//     rule), because each of them decides whether a mint happens at all.
//
// The pipeline is stubbed on purpose. This file pins what genesis.js SYNTHESIZES; what
// issue.js then makes of it (the IS_GENESIS exemptions, the parent gate) is that handler's
// own lane and its own tests.

const assert = require('assert');

const Genesis = require('../../src/genesis.js');

const ROOT_HASH   = 'GENESIS-DOGE-BRIDGE-35cbfdc6c3f97424fc32843d0f69caa9f0a5d7b873efa215';
const CHILD_HASH  = 'GENESIS-DOGE-BRIDGE-029afbb3bb78818645894494fa46d47f073219b132184e1a';
const REPARM_HASH = 'GENESIS-DOGE-BRIDGEDEC-cf56c32fe13c1b75689bda41efc1068002b75bbbaaabefad';

const ROOT_DATA  = 'ISSUE|0|BTC|||0|Bridge root for assets native to BTC|||||1|1|1|1|||||||999999999||1|1';
const CHILD_DATA = 'ISSUE|0|BTC.FUFU|||2|Bridged from BTC|||||1|1|1|1|||||||999999999||1|1';

const BRIDGE_OWNER = 'DOGE-bridge-btc-role';
const CTX          = { blockIndex: 5, blockTime: 6, txHashPrefix: 'GENESIS-' };

// rows: { tick -> getTokenInfo record }. A tick absent from the map has no ticker id either,
// which is what the non-interning probe in genesis.js keys on.
function harness(rows){
    const sent = [];
    const util = {
        isNull: (v) => (v === null || v === undefined || v === ''),
        bcgt:   (a, b) => Number(a) > Number(b)
    };
    const actions   = { processTransaction: async (tx, isGenesis) => { sent.push({ tx, isGenesis }); } };
    const indexerDb = {
        getTickerId:  async (tick) => (rows && rows[tick]) ? 42 : null,
        getTokenInfo: async (tick) => (rows && rows[tick]) ? rows[tick] : false
    };
    const config = { COIN: 'DOGE', NETWORK: 'regtest', GAS: 'XCHAIN', ADDRESS: { GAS: 'doge-gas' } };
    return { sent, genesis: new Genesis(actions, indexerDb, config, util) };
}

function lock(overrides){
    return Object.assign({ TICK: 'BTC', OWNER: BRIDGE_OWNER, DECIMALS: 2, SUPPLY: '0' }, overrides || {});
}

describe('genesis.injectProtocolToken and the bridged row creation @regression', function () {

    describe('the wire string the helper builds', function () {

        it('carries the ISSUE format 0 fields in order and trims only the trailing empties', async function () {
            const h = harness();
            await h.genesis.injectProtocolToken({
                tick: 'TESTTICK', owner: 'owner-address', maxSupply: '5000', decimals: '3',
                lockMaxSupply: '1', mintStartBlock: '777', mintSupply: '10',
                description: 'a description', locks: { LOCK_SLEEP: '1' }
            }, CTX);
            // MAX_SUPPLY, then the empty MAX_MINT, DECIMALS, DESCRIPTION, MINT_SUPPLY, the two
            // empty TRANSFER fields, LOCK_MAX_SUPPLY, the three empty locks, LOCK_SLEEP, and so
            // on to MINT_START_BLOCK; LOCK_MINT and LOCK_MINT_SUPPLY are empty and trimmed away.
            assert.strictEqual(h.sent[0].tx.data,
                'ISSUE|0|TESTTICK|5000||3|a description|10|||1|||1||||||||777');
            const fields = h.sent[0].tx.data.split('|');
            assert.strictEqual(fields.length, 22, 'the list stops at MINT_START_BLOCK');
            assert.strictEqual(fields[10], '1',   'LOCK_MAX_SUPPLY sits at its format position');
            assert.strictEqual(fields[13], '1',   'LOCK_SLEEP sits at its format position');
            assert.strictEqual(fields[21], '777', 'MINT_START_BLOCK is the last field kept');
        });

        it('keeps the fields past MINT_START_BLOCK when a later one is set', async function () {
            const h = harness();
            await h.genesis.injectProtocolToken({
                tick: 'TESTTICK', owner: 'owner-address', maxSupply: '', decimals: '0',
                lockMaxSupply: '', mintStartBlock: '999999999', mintSupply: '',
                description: 'd', locks: { LOCK_MINT_SUPPLY: '1' }
            }, CTX);
            const fields = h.sent[0].tx.data.split('|');
            assert.strictEqual(fields.length, 25, 'the list runs to LOCK_MINT_SUPPLY');
            assert.strictEqual(fields[24], '1');
            assert.strictEqual(fields[23], '', 'LOCK_MINT is untouched');
        });

        it('never emits a TRANSFER: an injected row is created owned by its final owner', async function () {
            const h = harness();
            await h.genesis.injectProtocolToken({
                tick: 'TESTTICK', owner: 'owner-address', maxSupply: '1', decimals: '0',
                lockMaxSupply: '', mintStartBlock: '1', mintSupply: '', description: 'd', locks: {}
            }, CTX);
            const fields = h.sent[0].tx.data.split('|');
            assert.strictEqual(fields[8], '', 'TRANSFER');
            assert.strictEqual(fields[9], '', 'TRANSFER_SUPPLY');
            assert.strictEqual(h.sent[0].tx.source, 'owner-address');
        });

    });

    describe('the first in-leg for a token on this chain', function () {

        it('creates the root row and then the child row, in that order', async function () {
            const h = harness();
            const out = await h.genesis.injectBridgedToken(
                { origin: 'BTC', name: 'FUFU', decimals: 2, owner: BRIDGE_OWNER }, CTX);
            assert.deepStrictEqual(out, {
                ok: true, reason: null, tick: 'BTC.FUFU',
                rootCreated: true, childCreated: true, reparameterized: false
            });
            assert.strictEqual(h.sent.length, 2);
            assert.strictEqual(h.sent[0].tx.data, ROOT_DATA);
            assert.strictEqual(h.sent[1].tx.data, CHILD_DATA);
            // The root must exist before the child: issue.js's parent gate reads the parent's
            // owner, and both legs carry the same source, so the order is the whole reason the
            // gate passes without an exemption.
            assert.strictEqual(h.sent[0].tx.data.split('|')[2], 'BTC');
            assert.strictEqual(h.sent[1].tx.data.split('|')[2], 'BTC.FUFU');
        });

        it('pins the two synthetic tx hashes, which a reindex must reproduce', async function () {
            const h = harness();
            await h.genesis.injectBridgedToken(
                { origin: 'BTC', name: 'FUFU', decimals: 2, owner: BRIDGE_OWNER }, CTX);
            assert.strictEqual(h.sent[0].tx.tx_hash, ROOT_HASH);
            assert.strictEqual(h.sent[1].tx.tx_hash, CHILD_HASH);
            assert.notStrictEqual(h.sent[0].tx.tx_hash, h.sent[1].tx.tx_hash);
        });

        it('sets every lock a keyless copy needs and never LOCK_MAX_SUPPLY', async function () {
            const h = harness();
            await h.genesis.injectBridgedToken(
                { origin: 'BTC', name: 'FUFU', decimals: 2, owner: BRIDGE_OWNER }, CTX);
            for(const tx of h.sent){
                const f = tx.tx.data.split('|');
                assert.strictEqual(f[10], '', 'LOCK_MAX_SUPPLY stays unset: a lock with no cap is refused');
                assert.strictEqual(f[3],  '', 'MAX_SUPPLY omitted: the uncapped sentinel');
                assert.strictEqual(f[11], '1', 'LOCK_MAX_MINT');
                assert.strictEqual(f[12], '1', 'LOCK_DESCRIPTION');
                assert.strictEqual(f[13], '1', 'LOCK_SLEEP');
                assert.strictEqual(f[14], '1', 'LOCK_CALLBACK');
                assert.strictEqual(f[23], '1', 'LOCK_MINT');
                assert.strictEqual(f[24], '1', 'LOCK_MINT_SUPPLY');
                assert.strictEqual(tx.tx.source, BRIDGE_OWNER);
                assert.strictEqual(tx.isGenesis, true);
            }
        });

        it('creates only the child when the bridge already owns the root', async function () {
            const h = harness({ BTC: lock({ DECIMALS: 0 }) });
            const out = await h.genesis.injectBridgedToken(
                { origin: 'BTC', name: 'FUFU', decimals: 2, owner: BRIDGE_OWNER }, CTX);
            assert.strictEqual(out.ok, true);
            assert.strictEqual(out.rootCreated, false);
            assert.strictEqual(out.childCreated, true);
            assert.strictEqual(h.sent.length, 1);
            assert.strictEqual(h.sent[0].tx.data, CHILD_DATA);
        });

    });

    describe('the existing-row rules (token bridge section 6)', function () {

        it('refuses the leg when the root is owned by anyone but the bridge role address', async function () {
            const h = harness({ BTC: lock({ OWNER: 'a-squatter' }) });
            const out = await h.genesis.injectBridgedToken(
                { origin: 'BTC', name: 'FUFU', decimals: 2, owner: BRIDGE_OWNER }, CTX);
            assert.strictEqual(out.ok, false);
            assert.ok(/a-squatter/.test(out.reason), 'the reason names the owner it found');
            assert.strictEqual(h.sent.length, 0, 'nothing is injected on a refusal');
        });

        it('applies with nothing injected when the child already carries the signed decimals', async function () {
            const h = harness({ BTC: lock(), 'BTC.FUFU': lock({ TICK: 'BTC.FUFU', DECIMALS: 2, SUPPLY: '500' }) });
            const out = await h.genesis.injectBridgedToken(
                { origin: 'BTC', name: 'FUFU', decimals: 2, owner: BRIDGE_OWNER }, CTX);
            assert.strictEqual(out.ok, true);
            assert.strictEqual(out.childCreated, false);
            assert.strictEqual(out.reparameterized, false);
            assert.strictEqual(h.sent.length, 0);
        });

        it('compares decimals by value, so a numeric row and a string record agree', async function () {
            const h = harness({ BTC: lock(), 'BTC.FUFU': lock({ TICK: 'BTC.FUFU', DECIMALS: 8, SUPPLY: '0' }) });
            const out = await h.genesis.injectBridgedToken(
                { origin: 'BTC', name: 'FUFU', decimals: '8', owner: BRIDGE_OWNER }, CTX);
            assert.strictEqual(out.reparameterized, false);
            assert.strictEqual(h.sent.length, 0);
        });

        it('re-parameterizes a supply-free row whose decimals differ', async function () {
            const h = harness({ BTC: lock(), 'BTC.FUFU': lock({ TICK: 'BTC.FUFU', DECIMALS: 2, SUPPLY: '0' }) });
            const out = await h.genesis.injectBridgedToken(
                { origin: 'BTC', name: 'FUFU', decimals: 4, owner: BRIDGE_OWNER }, CTX);
            assert.strictEqual(out.ok, true);
            assert.strictEqual(out.reparameterized, true);
            assert.strictEqual(h.sent.length, 1);
            // Only TICK and DECIMALS: every empty field back-fills from the current row, so the
            // owner, locks, description and mint window are untouched.
            assert.strictEqual(h.sent[0].tx.data, 'ISSUE|0|BTC.FUFU|||4');
            assert.strictEqual(h.sent[0].tx.source, BRIDGE_OWNER);
            // A distinct family and the new precision as the salt, so this transaction can
            // never collide with the creation or with a later move to another precision.
            assert.strictEqual(h.sent[0].tx.tx_hash, REPARM_HASH);
            assert.notStrictEqual(h.sent[0].tx.tx_hash, CHILD_HASH);
        });

        it('gives two different precisions two different transaction hashes', async function () {
            const a = harness({ BTC: lock(), 'BTC.FUFU': lock({ TICK: 'BTC.FUFU', DECIMALS: 2, SUPPLY: '0' }) });
            await a.genesis.injectBridgedToken({ origin: 'BTC', name: 'FUFU', decimals: 4, owner: BRIDGE_OWNER }, CTX);
            const b = harness({ BTC: lock(), 'BTC.FUFU': lock({ TICK: 'BTC.FUFU', DECIMALS: 2, SUPPLY: '0' }) });
            await b.genesis.injectBridgedToken({ origin: 'BTC', name: 'FUFU', decimals: 6, owner: BRIDGE_OWNER }, CTX);
            assert.notStrictEqual(a.sent[0].tx.tx_hash, b.sent[0].tx.tx_hash);
        });

        it('refuses and injects nothing when the decimals differ and supply exists', async function () {
            const h = harness({ BTC: lock(), 'BTC.FUFU': lock({ TICK: 'BTC.FUFU', DECIMALS: 2, SUPPLY: '0.00000001' }) });
            const out = await h.genesis.injectBridgedToken(
                { origin: 'BTC', name: 'FUFU', decimals: 4, owner: BRIDGE_OWNER }, CTX);
            assert.strictEqual(out.ok, false);
            assert.ok(/BTC\.FUFU/.test(out.reason), 'the reason names the row');
            assert.strictEqual(out.reparameterized, false);
            assert.strictEqual(h.sent.length, 0);
        });

    });

    describe('idempotency across legs', function () {

        it('a second leg for the same token injects nothing', async function () {
            const first = harness();
            await first.genesis.injectBridgedToken(
                { origin: 'BTC', name: 'FUFU', decimals: 2, owner: BRIDGE_OWNER }, CTX);
            // The rows the first leg created, as a later leg would read them back.
            const second = harness({
                BTC:         lock({ DECIMALS: 0 }),
                'BTC.FUFU':  lock({ TICK: 'BTC.FUFU', DECIMALS: 2, SUPPLY: '5' })
            });
            const out = await second.genesis.injectBridgedToken(
                { origin: 'BTC', name: 'FUFU', decimals: 2, owner: BRIDGE_OWNER }, CTX);
            assert.deepStrictEqual(out, {
                ok: true, reason: null, tick: 'BTC.FUFU',
                rootCreated: false, childCreated: false, reparameterized: false
            });
            assert.strictEqual(second.sent.length, 0);
        });

        it('a second origin chain gets its own root, and the two roots never share a hash', async function () {
            const h = harness();
            await h.genesis.injectBridgedToken({ origin: 'BTC', name: 'FUFU', decimals: 2, owner: BRIDGE_OWNER }, CTX);
            const l = harness();
            await l.genesis.injectBridgedToken({ origin: 'LTC', name: 'FUFU', decimals: 2, owner: 'DOGE-bridge-ltc-role' }, CTX);
            assert.strictEqual(l.sent[0].tx.data.split('|')[2], 'LTC');
            assert.strictEqual(l.sent[1].tx.data.split('|')[2], 'LTC.FUFU');
            assert.notStrictEqual(l.sent[0].tx.tx_hash, h.sent[0].tx.tx_hash);
            assert.notStrictEqual(l.sent[1].tx.tx_hash, h.sent[1].tx.tx_hash);
        });

    });

});

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// SLASH action handler: the snapshot reorg buffer. A proof's signer set is
// resolved at the BURIED height the hub used, for membership and the
// delegated-owner lookup alike, with the pre-flag-day arm pinned inert.
// Part of the SLASH suite; see ../slash.test.js.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const srb   = require('../../../../src/snapshot_reorg_buffer.js');
const Slash = require('../../../../src/actions/slash/index.js');
const {
    buried, params, data, dexProof, configProof, useSlashHarness,
} = require('./helpers/slash_harness.js');

// Each test gets a fresh harness from useSlashHarness; bind() hands it to the
// names the test bodies use.
let indexer, ctx, handler, offender;
const bind = (h) => { ({ indexer, ctx, handler, offender } = h); };

// ── Snapshot reorg buffer: resolve the proof's set where the SIGNER resolved it ──
//
// The wire carries the RAW declared snapshot_block, and every verifier buries it once
// locally (snapshot_reorg_buffer). SLASH was the family that did not, so a validator
// whose stake activated inside (declared - 6, declared] was absent from the set the
// verifier re-derived while being present in the set the hub actually locked: a genuine
// equivocation proof against it was rejected, and the bond never burned. The mirror case
// is worse - a validator whose stake DEACTIVATED in that window is in the raw-height set
// but was never in the signer set, so a proof naming it burned a bond over a slot it had
// no part in.

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('resolves capability membership at the BURIED height, not the declared one', async function () {
        // The set exists ONLY at the buried height: exactly the shape of a stake that
        // activated inside the buried window. Pre-fix this read the declared height, found
        // nothing, and rejected a real proof.
        indexer.indexerDb.getValidatorsByCapability = sinon.stub()
            .callsFake(async (cap, blk) => (blk === buried(100)) ? [{ pubkey: offender.pubHex, amount: '1000' }] : []);

        const { msgA, msgB } = dexProof();   // declares snapshot_block 100
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid', 'got ' + d['STATUS']);
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args,
            ['cross_chain', buried(100)], 'membership must be read at the buried height');
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce, 'the bond must burn');
    });

    it('resolves XCONFIG federation membership at the BURIED height too', async function () {
        indexer.indexerDb.getActiveValidators = sinon.stub()
            .callsFake(async (blk) => (blk === buried(150)) ? [{ pubkey: offender.pubHex, amount: '1000' }] : []);

        const { msgA, msgB } = configProof(150);
        const d = data();
        await handler.parse(params('config', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid', 'got ' + d['STATUS']);
        assert.deepStrictEqual(indexer.indexerDb.getActiveValidators.firstCall.args, [buried(150)]);
    });

    it('membership and the delegated-owner lookup read the SAME height', async function () {
        // Deciding "was this key authorized to sign" and "whose bond is that" at two
        // different heights is what produced a valid slash event that burned nothing.
        indexer.indexerDb.getStakeSourceForDelegatedPubkey = sinon.stub().resolves(42);
        const { msgA, msgB } = dexProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.strictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args[1],
                           indexer.indexerDb.getStakeSourceForDelegatedPubkey.firstCall.args[1],
                           'the two reads must agree, or an authorized key resolves to no owner');
    });
});

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('the reject message still names the DECLARED height (the offender signed that, not the buried one)', async function () {
        indexer.indexerDb.getValidatorsByCapability = sinon.stub().resolves([]);
        const { msgA, msgB } = dexProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.ok(/snapshot at block 100$/.test(d['STATUS']),
            'the STATUS string is consensus bytes; it must not move with the buffer. got ' + d['STATUS']);
    });

    it('BELOW the flag-day both reads use the declared height verbatim', async function () {
        // Burial changes acceptance, so it is flag-day gated per network. Every network is
        // armed at genesis now, so the pre-flag-day era is reached by pinning the burial
        // key inert (`null` is that map's own INERT marker) for the duration of the call
        // rather than by naming a network. Below the gate this handler must be
        // byte-identical to its pre-fix self.
        const map   = srb.SNAPSHOT_BURIAL_ACTIVATION;
        const saved = map.mainnet;
        map.mainnet = null;

        const mainnetCtx = Object.assign({}, ctx, {
            config: Object.assign({}, indexer.config, { NETWORK: 'mainnet' }),
        });
        const mainnetHandler = new Slash(mainnetCtx);
        indexer.indexerDb.getStakeSourceForDelegatedPubkey = sinon.stub().resolves(42);

        const { msgA, msgB } = dexProof();
        const d = data();
        try {
            await mainnetHandler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);
        } finally { map.mainnet = saved; }

        assert.strictEqual(d['STATUS'], 'valid');
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args, ['cross_chain', 100]);
        assert.strictEqual(indexer.indexerDb.getStakeSourceForDelegatedPubkey.firstCall.args[1], 100);
    });
});

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('AT the flag-day on mainnet both reads use the BURIED height', async function () {
        // The other half of the pair, on the shipped key: mainnet is armed at genesis, so
        // the same proof that resolves at the declared height above now resolves where the
        // signer resolved it. Both reads must move together or an authorized key resolves
        // to no owner.
        const mainnetCtx = Object.assign({}, ctx, {
            config: Object.assign({}, indexer.config, { NETWORK: 'mainnet' }),
        });
        const mainnetHandler = new Slash(mainnetCtx);
        indexer.indexerDb.getStakeSourceForDelegatedPubkey = sinon.stub().resolves(42);

        const { msgA, msgB } = dexProof();
        const d = data();
        await mainnetHandler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid', 'got ' + d['STATUS']);
        assert.deepStrictEqual(indexer.indexerDb.getValidatorsByCapability.firstCall.args,
            ['cross_chain', buried(100)]);
        assert.strictEqual(indexer.indexerDb.getStakeSourceForDelegatedPubkey.firstCall.args[1], buried(100));
    });
});

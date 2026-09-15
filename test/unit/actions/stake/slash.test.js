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
// SLASH action handler: the deterministic equivocation verifier for
// capability stakes. Exercises the consensus-critical accept/reject decision with REAL
// Ed25519 signatures and a stubbed DB (no mariadb → runs on any Node). The burn
// itself (slashCapabilityStake) is unit-tested separately; here we assert the
// verifier only fires on a genuine equivocation and rejects every near-miss.
//
// This file holds the genuine DEX accept, the ledger effect of a burn, the
// delegated offender and the bounty and treasury split. The snapshot burial,
// the near-miss rejects and the XCONFIG, oracle, checkpoint and attest engines
// live beside it in slash.test/, each opening the same describe title so every
// full test title is unchanged; slash.test/helpers/slash_harness.js holds the
// keys, proofs and mock harness they share.

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const { buried, params, data, dexProof, useSlashHarness } = require('./slash.test/helpers/slash_harness.js');

// Each test gets a fresh harness from useSlashHarness; bind() hands it to the
// names the test bodies use.
let indexer, handler, offender;
const bind = (h) => { ({ indexer, handler, offender } = h); };

// A bond is LOCKED in the staker's escrow, so a slash REDIRECTS tokens rather than
// minting them. These assert the whole ledger effect of one slash, not that a call was
// made: supply delta = credits - debits + escrows.
function ledgerOf(applied){
    const [, , credits, debits, escrows] = applied.firstCall.args;
    const sum = rows => (rows || []).reduce((a, r) => a + Number(r[1]), 0);
    return { credits, debits, escrows, sum,
             delta: sum(credits) - sum(debits) + sum(escrows) };
}

function withSlashConfig(cfg) {
    indexer.config.STAKING = { CAPABILITIES: { cross_chain: { MIN_STAKE: '5000', SLASH: cfg } } };
}

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('ACCEPTS a genuine DEX equivocation and burns the bond', async function () {
        const { key, msgA, msgB } = dexProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex,msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        assert.ok(indexer.indexerDb.slashCapabilityStake.calledOnce, 'slashCapabilityStake must be called once');
        // 4th arg is burnPending: true here since the mock flag defaults on.
        // 5th is ownerSourceId: null because this offender stakes in its own name.
        assert.deepStrictEqual(indexer.indexerDb.slashCapabilityStake.firstCall.args, [7, 200, 999, true, null]);
        assert.ok(indexer.indexerDb.createCapabilitySlashEvent.calledOnce, 'an audit event must be written');
    });

    it('releases the burned bond from the STAKERS escrow, per owner, not from the submitter', async function () {
        indexer.config.STAKING = { CAPABILITIES: { cross_chain: { MIN_STAKE: '5000',
            SLASH: { BOUNTY_BPS: 500 } } } };                       // 5% bounty, remainder BURNED
        indexer.indexerDb.slashCapabilityStake = sinon.stub().resolves({
            total: '1000',
            releases: [{ address: 'stakerA', amount: '600' }, { address: 'stakerB', amount: '400' }]
        });
        const applied = sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();

        const { msgA, msgB } = dexProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        const L = ledgerOf(applied);
        // The release is keyed to whoever HOLDS the lock. A delegated key's bond lives on the
        // owning source, so this is not data['SOURCE'] and cannot be assumed to be one address.
        assert.deepStrictEqual(L.escrows.map(r => r[2]).sort(), ['stakerA', 'stakerB']);
        assert.strictEqual(L.sum(L.escrows), -1000, 'the whole bond must come out of escrow');
        assert.strictEqual(L.sum(L.credits), 50,    'only the 5% bounty re-enters circulation');
        // 950 was redirected to a treasury with no address, i.e. genuinely burned. Supply
        // falls by exactly that, and by nothing else.
        assert.strictEqual(L.delta, -950,
            'supply must fall by the UNREDIRECTED remainder - no more (a mint) and no less (a strand)');
    });
});

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    it('a fully redirected slash moves no supply at all', async function () {
        indexer.config.STAKING = { CAPABILITIES: { cross_chain: { MIN_STAKE: '5000',
            SLASH: { BOUNTY_BPS: 500, TREASURY_ADDRESS: 'addrT' } } } };
        indexer.indexerDb.slashCapabilityStake = sinon.stub().resolves({
            total: '1000', releases: [{ address: 'stakerA', amount: '1000' }]
        });
        const applied = sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();

        const { msgA, msgB } = dexProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        const L = ledgerOf(applied);
        assert.strictEqual(L.sum(L.credits), 1000, 'bounty + treasury account for the whole bond');
        assert.strictEqual(L.sum(L.escrows), -1000);
        assert.strictEqual(L.delta, 0, 'nothing was destroyed, so supply must not move');
    });

    it('a zero burn writes no escrow release', async function () {
        indexer.indexerDb.slashCapabilityStake = sinon.stub().resolves({ total: '0', releases: [] });
        const applied = sinon.stub(indexer.util, 'processTransactionLedgerChanges').resolves();

        const { msgA, msgB } = dexProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid', 'an emptied bond still records a valid slash');
        const L = ledgerOf(applied);
        assert.strictEqual(L.escrows.length, 0);
        assert.strictEqual(L.delta, 0);
    });
});

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    // A delegated signing key owns no stake, so burning by its own pubkey
    // matched nothing: the slash recorded as valid and burned ZERO. The handler must
    // resolve the owning source AT THE EQUIVOCATION HEIGHT and burn there.
    it('a DELEGATED offender burns the owning source\'s bond, resolved at the equivocation height', async function () {
        indexer.indexerDb.getStakeSourceForDelegatedPubkey = sinon.stub().resolves(42);
        const { msgA, msgB } = dexProof();
        const d = data();
        await handler.parse(params('cross_chain', offender.pubHex, msgA, offender.privateKey, msgB, offender.privateKey), d, null);

        assert.strictEqual(d['STATUS'], 'valid');
        const resolve = indexer.indexerDb.getStakeSourceForDelegatedPubkey.firstCall;
        assert.ok(resolve, 'the handler must attempt a delegated-owner resolution');
        assert.strictEqual(resolve.args[0], 7, 'resolved for the offending pubkey id');
        // 100 is the proof's declared snapshot_block (dexContent snapA); 200 is BLOCK_INDEX,
        // the processing height. They differ here on purpose: that gap is the whole point of
        // the pinned resolution. Revoking the delegation between the offence and 200 must not
        // orphan the proof, so the resolution must read the equivocation height, and it must
        // read the BURIED one so it names the same delegation the membership check above
        // accepted the key under.
        assert.strictEqual(resolve.args[1], buried(100),
            'must resolve at the BURIED equivocation height, not the processing height');
        assert.notStrictEqual(resolve.args[1], 100,
            'the buried height must actually differ from the declared one on regtest, or this asserts nothing');
        assert.strictEqual(indexer.indexerDb.slashCapabilityStake.firstCall.args[4], 42,
            'the burn must target the owning stake source');
    });
});

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    // ── Bounty / treasury split (governance config + BURN default) ──
    describe('bountyTreasurySplit', function () {
        it('pure burn when no SLASH config (bounty 0, no treasury credit)', function () {
            // Explicit no-SLASH config: the real BTC.js now ships SLASH defaults, so assert
            // the absent-config path against a config that deliberately omits the SLASH block.
            indexer.config.STAKING = { CAPABILITIES: { cross_chain: { MIN_STAKE: '5000' } } };
            const s = handler.bountyTreasurySplit('cross_chain', '1000');
            assert.strictEqual(Number(s.bounty), 0);
            assert.strictEqual(s.treasuryAddr, null);          // null = BURN
            assert.strictEqual(Number(s.treasury), 1000);      // the whole bond leaves circulation
        });

        it('applies BOUNTY_BPS and routes the remainder to the treasury', function () {
            withSlashConfig({ BOUNTY_BPS: 500, TREASURY_ADDRESS: 'addrT' });   // 5%
            const s = handler.bountyTreasurySplit('cross_chain', '1000');
            assert.strictEqual(Number(s.bounty), 50);
            assert.strictEqual(Number(s.treasury), 950);
            assert.strictEqual(s.treasuryAddr, 'addrT');
            // Conservation: bounty + treasury == burned (never mints, never loses).
            assert.strictEqual(Number(indexer.util.bcadd(s.bounty, s.treasury, 8)), 1000);
            assert.strictEqual(typeof s.bounty, 'string');   // ledger sees plain strings, not BigNumbers
        });

        it('clamps the bounty to BOUNTY_CAP', function () {
            withSlashConfig({ BOUNTY_BPS: 5000, BOUNTY_CAP: '10', TREASURY_ADDRESS: 'addrT' });   // 50% capped at 10
            const s = handler.bountyTreasurySplit('cross_chain', '1000');
            assert.strictEqual(Number(s.bounty), 10);
            assert.strictEqual(Number(s.treasury), 990);
        });

        it('clamps BOUNTY_BPS to 100% (never pays more than the bond)', function () {
            withSlashConfig({ BOUNTY_BPS: 99999, TREASURY_ADDRESS: 'addrT' });
            const s = handler.bountyTreasurySplit('cross_chain', '1000');
            assert.strictEqual(Number(s.bounty), 1000);
            assert.strictEqual(Number(s.treasury), 0);
        });

        it('a zero burn splits to all-zero with no treasury credit', function () {
            withSlashConfig({ BOUNTY_BPS: 500, TREASURY_ADDRESS: 'addrT' });
            const s = handler.bountyTreasurySplit('cross_chain', '0');
            assert.strictEqual(Number(s.bounty), 0);
            assert.strictEqual(Number(s.treasury), 0);
            assert.strictEqual(s.treasuryAddr, null);
        });

        it('raises a sub-floor bounty to BOUNTY_FLOOR (cost-coverage on small bonds)', function () {
            withSlashConfig({ BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000' });   // 5% of 500 = 25 < floor 50
            const s = handler.bountyTreasurySplit('cross_chain', '500');
            assert.strictEqual(Number(s.bounty), 50);    // floor wins over the 25 the bps would give
            assert.strictEqual(Number(s.treasury), 450); // remainder burned (no TREASURY_ADDRESS)
            assert.strictEqual(s.treasuryAddr, null);
        });
    });
});

describe('SLASH action handler: equivocation verifier @regression', function () {
    useSlashHarness(bind);

    describe('bountyTreasurySplit', function () {
        it('clamps the floor to the bond: a sub-floor bond never mints', function () {
            withSlashConfig({ BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000' });
            const s = handler.bountyTreasurySplit('cross_chain', '30');   // bond < floor
            assert.strictEqual(Number(s.bounty), 30);    // pays the whole bond, not 50
            assert.strictEqual(Number(s.treasury), 0);
            // Conservation: never pays out more than was burned.
            assert.strictEqual(Number(indexer.util.bcadd(s.bounty, s.treasury, 8)), 30);
        });

        it('the cap still wins over the floor when both are set', function () {
            withSlashConfig({ BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000', BOUNTY_CAP: '40.00000000' });
            const s = handler.bountyTreasurySplit('cross_chain', '5000');  // 5% = 250, floor 50, cap 40
            assert.strictEqual(Number(s.bounty), 40);    // cap is the hard ceiling, applied last
        });

        it('XCONFIG reads config.CONFIG_SLASH (whole-federation, no CAPABILITIES home)', function () {
            indexer.config.CONFIG_SLASH = { BOUNTY_BPS: 500, BOUNTY_FLOOR: '50.00000000', BOUNTY_CAP: '1000.00000000' };
            const s = handler.bountyTreasurySplit('config', '5000');
            assert.strictEqual(Number(s.bounty), 250);   // 5% of 5000
            assert.strictEqual(Number(s.treasury), 4750);
            assert.strictEqual(s.treasuryAddr, null);     // burned
        });

        it('XCONFIG is a pure burn when no CONFIG_SLASH is configured', function () {
            delete indexer.config.CONFIG_SLASH;
            const s = handler.bountyTreasurySplit('config', '5000');
            assert.strictEqual(Number(s.bounty), 0);
            assert.strictEqual(Number(s.treasury), 5000);
            assert.strictEqual(s.treasuryAddr, null);
        });
    });
});

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
 * The indexer's binding rule and its canonical twins under the mirror-admission
 * flag day (the time-keyed mirror barrier family, sections 5.5 and 5.6, row 5).
 *
 * WHAT IS DRIVEN, IN BOTH ARMS. Every predicate and every twin below is run with the
 * activation INERT (today's behaviour, byte for byte) and ARMED on regtest, at height 0
 * and at a realistic height, because the activation resolver freezes at require time
 * and a suite that only ran whichever arming the process launched with would leave one
 * whole era vacuous. Arming at 0 is what catches the `Number(null)` is 0 trap: an
 * unreadable height coerced to 0 sits ABOVE a threshold of 0 and below any realistic
 * one, so a suite armed only at 799000 certifies the null guards without testing them.
 *
 *   - The four consensus-critical canonical twins (match, call dispatch and result,
 *     bridge transfer, policy snapshot) and the attest-response canonical are compared
 *     BYTE FOR BYTE against the hub's own builders, required out of the sibling checkout
 *     and driven with a stub `this`, legacy rows and admission-era rows alike.
 *   - An admission-era row with no admission columns REFUSES on both sides rather than
 *     verifying as legacy.
 *   - The mirrored selects (match, two call reads in both mirror topologies, the attest
 *     response read, the bridge transfer and policy selects) issue their pre-train SQL
 *     text byte for byte below the activation and the C33 form above it, asserted as
 *     literal strings against a capturing stub database.
 *   - The attest-response bind predicate binds by admit_block_btc above the activation
 *     and by effective_time below it, with every other clause untouched.
 *   - The direct-hub-DB call-presence member reads the hub's persisted admission floor
 *     above the activation, fails closed on every unusable reading, retires the hub-clock
 *     escape, and keeps its coin scope and its clock form below it.
 *
 ********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN || 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const sinon  = require('sinon');

const eq = require('../../src/equivocation_header.js');
const { sleep } = require('../helpers/wait.js');

const NETWORK   = 'regtest';
const ADMIT_AT  = 799000;                       // the realistic arming height
const LEGACY_AT = ADMIT_AT - 1;

const HUB_SRC  = path.resolve(__dirname, '../../../xchain-hub/src');
const HAVE_HUB = fs.existsSync(path.join(HUB_SRC, 'CrossChainDexEngine.js'));
if (!HAVE_HUB && process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
    throw new Error('admission binding parity cannot run: xchain-hub sibling missing at ' + HUB_SRC);

// Every module that captures a function off the activation twin at require time, so an
// arming has to purge and re-require all of them or the consumer keeps the old arm.
const LOCAL_MODULES = [
    '../../src/mirror_admission_activation.js',
    '../../src/attest_response_canonical.js',
    '../../src/actions/xcall.js',
    '../../src/actions/xexec.js',
    '../../src/actions/cross_settle.js',
    '../../src/bridge_settle.js',
    '../../src/db',
    '../../src/utility.js',
    '../../src/XChainIndexer.js'
];
const HUB_MODULES = [
    '../../../xchain-hub/src/mirror_admission_activation.js',
    '../../../xchain-hub/src/lib/admission_height.js',
    '../../../xchain-hub/src/CrossChainDexEngine.js',
    '../../../xchain-hub/src/CrossChainCallEngine.js',
    '../../../xchain-hub/src/CrossChainBridgeEngine.js',
    '../../../xchain-hub/src/AttestationConsensus.js'
];

// Purge, arm (or disarm), re-require, and hand back everything a case needs plus the
// restore that puts the process back exactly as it was.
function load(activation) {
    const paths = LOCAL_MODULES.map(m => require.resolve(m))
        .concat(HAVE_HUB ? HUB_MODULES.map(m => require.resolve(m)) : []);
    const saved    = paths.map(p => [p, require.cache[p]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    for (const p of paths) delete require.cache[p];
    if (activation === null) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    else process.env.XC_MIRROR_ADMISSION_ACTIVATION = String(activation);

    const h = {
        activation,
        act:      require('../../src/mirror_admission_activation.js'),
        can:      require('../../src/attest_response_canonical.js'),
        Xcall:    require('../../src/actions/xcall.js'),
        Xexec:    require('../../src/actions/xexec.js'),
        Settle:   require('../../src/actions/cross_settle.js'),
        BS:       require('../../src/bridge_settle.js'),
        Database: require('../../src/db'),
        Utility:  require('../../src/utility.js'),
        Indexer:  require('../../src/XChainIndexer.js'),
        hub:      null
    };
    if (HAVE_HUB) {
        h.hub = {
            act:    require('../../../xchain-hub/src/mirror_admission_activation.js'),
            ah:     require('../../../xchain-hub/src/lib/admission_height.js'),
            Dex:    require('../../../xchain-hub/src/CrossChainDexEngine.js'),
            Call:   require('../../../xchain-hub/src/CrossChainCallEngine.js'),
            Bridge: require('../../../xchain-hub/src/CrossChainBridgeEngine.js'),
            Attest: require('../../../xchain-hub/src/AttestationConsensus.js')
        };
    }
    h.restore = function () {
        for (const [p, mod] of saved) {
            if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod;
        }
        if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    };
    return h;
}

// ---------------------------------------------------------------------------
// Fixtures: one row per rail, as the hub signs it and the mirror delivers it.
// ---------------------------------------------------------------------------

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// The stored admission map: BTC and DOGE stamped, LTC left NULL (its map never named
// LTC), which is exactly the C38 shape. Encoded in ASCII order.
const COLS  = { admit_block_btc: 799004, admit_block_ltc: null, admit_block_doge: 5000004 };
const FIELD = 'BTC:799004,DOGE:5000004';
const NO_COLS = { admit_block_btc: null, admit_block_ltc: null, admit_block_doge: null };

function matchRow(block, extra) {
    return Object.assign({
        match_id: 'm'.repeat(64), snapshot_block: block, network: NETWORK,
        a_chain: 'BTC', a_action_index: 10, a_tick: 'XCP', a_amount: '1.5', a_ownership: '1', a_payout_addr: 'addrA',
        b_chain: 'DOGE', b_action_index: 20, b_tick: 'XCP', b_amount: '2.5', b_ownership: '2', b_payout_addr: 'addrB',
        effective_time: 1700000000, a_kind: 'swap', a_filled_before: '0', b_kind: 'swap', b_filled_before: '0',
        a_payout_legs: '', b_payout_legs: '', finalizing_view: 0
    }, extra || {});
}
function dispatchRow(block, extra) {
    return Object.assign({
        call_id: 'c'.repeat(64), phase: 'dispatch', snapshot_block: block, network: NETWORK,
        source_chain: 'BTC', source_action_index: 10, source_contract_index: 2,
        target_chain: 'LTC', target_contract_index: 3, method: 'transfer', params_json: '["x"]',
        gas_limit: 1000000, cross_hops: 0, effective_time: 1700000000, finalizing_view: 0
    }, extra || {});
}
function resultRow(block, extra) {
    return Object.assign({
        call_id: 'c'.repeat(64), phase: 'result', snapshot_block: block, network: NETWORK,
        target_chain: 'LTC', result_status: 'ok', return_payload_b64: 'cmVz',
        effective_time: 1700000000, finalizing_view: 0
    }, extra || {});
}
function transferRow(block, extra) {
    return Object.assign({
        transfer_id: 't'.repeat(64), snapshot_block: block, network: NETWORK,
        tick: 'XCHAIN', decimals: 8, src_chain: 'BTC', src_action_index: 4242, src_address: 'mSrc',
        dest_chain: 'DOGE', dest_address: 'nDest', amount: '10.00000000',
        effective_time: 1700000000, finalizing_view: 0
    }, extra || {});
}
function policyRow(block, extra) {
    return Object.assign({
        snapshot_id: 'p'.repeat(64), snapshot_block: block, network: NETWORK,
        origin_chain: 'BTC', tick: 'XCHAIN', policy_seq: 3, origin_block: 1190, policy_hash: 'h'.repeat(64),
        effective_time: 1700000000, finalizing_view: 0
    }, extra || {});
}

// The pre-train bytes of each rail, spelled out by hand so the legacy identity is checked
// against the FORMAT and not against the module's own output. regtest arms the royalty and
// EQUIV gates at 0, so a regtest row carries the two royalty legs and the wrapper.
function legacyMatchBytes(r) {
    let raw = ['XMATCH', r.match_id, String(r.snapshot_block),
        r.a_chain, String(r.a_action_index), r.a_tick, String(r.a_amount), String(r.a_ownership), r.a_payout_addr,
        r.b_chain, String(r.b_action_index), r.b_tick, String(r.b_amount), String(r.b_ownership), r.b_payout_addr,
        String(r.effective_time), r.network, r.a_kind, String(r.a_filled_before), r.b_kind, String(r.b_filled_before)].join('|');
    if (r.network === NETWORK) raw += '|' + r.a_payout_legs + '|' + r.b_payout_legs;
    return eq.isEquivHeaderActive(r.snapshot_block, r.network)
        ? eq.buildEquivCanonical(eq.ENGINE_TAGS.DEX, r.match_id, 0, raw) : raw;
}
function legacyDispatchBytes(r) {
    const raw = ['XCALL', 'DISPATCH', r.call_id, String(r.snapshot_block), r.network,
        r.source_chain, String(r.source_action_index), String(r.source_contract_index),
        r.target_chain, String(r.target_contract_index), r.method, sha(r.params_json),
        String(r.gas_limit), String(r.cross_hops), String(r.effective_time)].join('|');
    return eq.isEquivHeaderActive(r.snapshot_block, r.network)
        ? eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL, sha('XCALLROUND|dispatch|' + r.call_id), 0, raw) : raw;
}
function legacyResultBytes(r) {
    const raw = ['XCALL', 'RESULT', r.call_id, String(r.snapshot_block), r.network,
        r.target_chain, r.result_status, sha(r.return_payload_b64), String(r.effective_time)].join('|');
    return eq.isEquivHeaderActive(r.snapshot_block, r.network)
        ? eq.buildEquivCanonical(eq.ENGINE_TAGS.XCALL, sha('XCALLROUND|result|' + r.call_id), 0, raw) : raw;
}
function legacyTransferBytes(r) {
    const raw = ['XBRIDGE', r.transfer_id, String(r.snapshot_block), r.tick, String(r.decimals),
        r.src_chain, String(r.src_action_index), r.src_address, r.dest_chain, r.dest_address,
        String(r.amount), String(r.effective_time), r.network].join('|');
    return eq.isEquivHeaderActive(r.snapshot_block, r.network)
        ? eq.buildEquivCanonical(eq.ENGINE_TAGS.BRIDGE, r.transfer_id, 0, raw) : raw;
}
function legacyPolicyBytes(r) {
    const raw = ['XPOLICY', r.snapshot_id, String(r.snapshot_block), r.origin_chain, r.tick,
        String(r.policy_seq), String(r.origin_block), r.policy_hash, String(r.effective_time), r.network].join('|');
    return eq.isEquivHeaderActive(r.snapshot_block, r.network)
        ? eq.buildEquivCanonical(eq.ENGINE_TAGS.POLICY, r.snapshot_id, 0, raw) : raw;
}

// The indexer twins, each driven the way its verifier drives it.
function indexerTwins(h) {
    const mk = () => ({ config: {}, decoderDb: null, indexerDb: null, util: null, mapper: null });
    const settle = new h.Settle(mk()), xexec = new h.Xexec(mk()), xcall = new h.Xcall(mk());
    return {
        match:    (r) => settle._canonical(r),
        dispatch: (r) => xexec._canonical(r),
        result:   (r) => xcall._resultCanonical(r),
        transfer: (r) => h.BS.transferCanonical(r),
        policy:   (r) => h.BS.policyCanonical(r)
    };
}

// The hub builders, driven on a stub `this` carrying only what each canonical reads.
function hubBuilders(h) {
    const C = h.hub.Call.prototype;
    const callThis = { _sha256: C._sha256, _roundId: C._roundId };
    return {
        match:    (r) => h.hub.Dex.prototype._canonicalMatch.call({}, r, r.finalizing_view),
        dispatch: (r) => h.hub.Call.prototype._canonicalMatch.call(callThis, r, r.finalizing_view),
        result:   (r) => h.hub.Call.prototype._canonicalMatch.call(callThis, r, r.finalizing_view),
        transfer: (r) => h.hub.Bridge.prototype._canonicalMatch.call({}, r, r.finalizing_view),
        policy:   (r) => h.hub.Bridge.prototype._canonicalMatch.call({}, r, r.finalizing_view)
    };
}

const RAILS = [
    ['match',    matchRow,    legacyMatchBytes],
    ['dispatch', dispatchRow, legacyDispatchBytes],
    ['result',   resultRow,   legacyResultBytes],
    ['transfer', transferRow, legacyTransferBytes],
    ['policy',   policyRow,   legacyPolicyBytes]
];

// The three arms every describe below runs under. `legacyBlock` is a regtest height that
// is BELOW the activation in that arm (none exists when armed at 0, so those cases use
// mainnet, which is inert at every height in this train); `modernBlock` is at/above it.
const ARMS = [
    { name: 'INERT (no env)',           activation: null,     modernBlock: null,     legacyBlock: LEGACY_AT },
    { name: 'ARMED at height 0',        activation: 0,        modernBlock: 0,        legacyBlock: null },
    { name: 'ARMED at height ' + ADMIT_AT, activation: ADMIT_AT, modernBlock: ADMIT_AT, legacyBlock: LEGACY_AT }
];

describe('admission binding: the verify-side canonical twins byte-match the hub builders', function () {

    for (const arm of ARMS) {
        describe(arm.name, function () {
            let h, twins, hub;
            before(function () { h = load(arm.activation); twins = indexerTwins(h); hub = h.hub ? hubBuilders(h) : null; });
            after(function () { if (h) h.restore(); h = null; });

            it('drives the hub builders out of the sibling checkout (PENDING here means no sibling, never a silent pass)', function () {
                if (!HAVE_HUB) { this.skip(); return; }
                assert.ok(hub !== null && typeof h.hub.Dex.prototype._canonicalMatch === 'function');
                assert.ok(typeof h.hub.Attest.prototype._buildCanonical === 'function');
            });

            it('is in the arm it says it is, so no case below is vacuous', function () {
                const armed = arm.activation !== null;
                assert.strictEqual(h.act.isMirrorAdmissionProducerActive('BTC', NETWORK, ADMIT_AT), armed);
                assert.strictEqual(h.act.isMirrorAdmissionProducerActive('BTC', NETWORK, 0), arm.activation === 0);
                assert.strictEqual(h.act.isMirrorAdmissionProducerActive('BTC', 'mainnet', ADMIT_AT + 1000000), false);
                if (h.hub) assert.strictEqual(h.hub.act.isMirrorAdmissionProducerActive('BTC', NETWORK, ADMIT_AT), armed,
                    'the hub twin must be armed identically or the parity below compares two eras');
            });

            for (const [rail, rowOf, legacyBytes] of RAILS) {

                it(rail + ': a legacy row below the activation rebuilds the pre-train bytes, equal to the hub', function () {
                    const row = (arm.legacyBlock !== null) ? rowOf(arm.legacyBlock) : rowOf(5, { network: 'mainnet' });
                    const got = twins[rail](row);
                    assert.strictEqual(got, legacyBytes(row), 'the legacy bytes must be the pre-train format exactly');
                    assert.ok(!/\|[A-Z]+:\d+(,[A-Z]+:\d+)*$/.test(got), 'no admission field on a legacy row: ' + got.slice(-40));
                    if (hub) assert.strictEqual(got, hub[rail](row));
                });

                if (arm.modernBlock !== null) {
                    it(rail + ': an admission-era row with columns appends the ASCII-ordered map, equal to the hub', function () {
                        const row = rowOf(arm.modernBlock, COLS);
                        const got = twins[rail](row);
                        assert.ok(got.endsWith('|' + FIELD), got.slice(-60));
                        // The field is APPENDED: strip it and the pre-train bytes are what is left.
                        const inner = got.slice(0, got.length - ('|' + FIELD).length);
                        assert.strictEqual(inner, legacyBytes(rowOf(arm.modernBlock)));
                        if (hub) {
                            assert.strictEqual(got, hub[rail](row));
                            assert.deepStrictEqual(h.hub.ah.rowAdmitBlocks(row), h.act.columnsAdmitBlocks(row),
                                'the hub and the indexer must read the same map back off the same columns');
                        }
                    });

                    it(rail + ': an admission-era row with NO columns REFUSES rather than verifying as legacy', function () {
                        assert.throws(() => twins[rail](rowOf(arm.modernBlock)), /refusing to build a legacy canonical/);
                        assert.throws(() => twins[rail](rowOf(arm.modernBlock, NO_COLS)), /refusing to build a legacy canonical/);
                        if (hub) assert.throws(() => hub[rail](rowOf(arm.modernBlock, NO_COLS)), /refusing to build a legacy canonical/);
                    });

                    it(rail + ': a different map is different bytes, and an unusable column is a refusal', function () {
                        const a = twins[rail](rowOf(arm.modernBlock, COLS));
                        const b = twins[rail](rowOf(arm.modernBlock, Object.assign({}, COLS, { admit_block_btc: 799005 })));
                        assert.notStrictEqual(a, b);
                        assert.throws(() => twins[rail](rowOf(arm.modernBlock, Object.assign({}, COLS, { admit_block_btc: 'abc' }))),
                            /not a usable admission height/);
                    });
                }

                it(rail + ': a legacy-era row handed columns REFUSES in the other direction', function () {
                    const row = (arm.legacyBlock !== null) ? rowOf(arm.legacyBlock, COLS) : rowOf(5, Object.assign({ network: 'mainnet' }, COLS));
                    assert.throws(() => twins[rail](row), /refusing to build an admission-era canonical/);
                    if (hub) assert.throws(() => hub[rail](row), /refusing to build an admission-era canonical/);
                });
            }
        });
    }
});

describe('admission binding: the attest-response canonical twin', function () {

    const RID  = 'r'.repeat(64);
    const BODY = Buffer.from('the attested body', 'utf8');
    const BASE = { requestId: RID, providerId: 'http_get', responseHash: sha('the attested body'), status: 'ok', meta: 'status=200' };

    // The hub's builder on a stub carrying only what it reads; the era gate and the
    // round-pinned default come from the real prototype.
    function hubCanonical(h, requestBlock, effectiveTime, admitBlocks, network) {
        const A = h.hub.Attest.prototype;
        const self = { hub: { network: network || NETWORK }, pending: null,
                       _isMirrorEra: A._isMirrorEra, _roundAdmitBlocks: A._roundAdmitBlocks };
        return A._buildCanonical.call(self, RID, BASE.providerId, BODY, BASE.status, BASE.meta,
                                      requestBlock, effectiveTime, admitBlocks).toString('utf8');
    }
    // The indexer side, wrapped exactly as attest_response_verify.js wraps it.
    function indexerCanonical(h, fields, requestBlock, network) {
        let raw = h.can.buildResponseCanonicalRaw(fields);
        return eq.isEquivHeaderActive(requestBlock, network || NETWORK)
            ? eq.buildEquivCanonical(eq.ENGINE_TAGS.ATTEST, RID, 0, raw) : raw;
    }

    for (const arm of ARMS) {
        describe(arm.name, function () {
            let h;
            before(function () { h = load(arm.activation); });
            after(function () { if (h) h.restore(); h = null; });

            it('with no requestBlock the bytes are the two-era form unchanged (the twin stays output-identical)', function () {
                const legacy = h.can.buildResponseCanonicalRaw(Object.assign({}, BASE));
                assert.strictEqual(legacy, RID + BASE.providerId + BASE.responseHash + BASE.status + BASE.meta);
                const mirror = h.can.buildResponseCanonicalRaw(Object.assign({}, BASE, { effectiveTime: 1234 }));
                assert.strictEqual(mirror, legacy + '|1234');
                if (h.hub) {
                    const hubTwin = require('../../../xchain-hub/src/attest_response_canonical.js');
                    assert.strictEqual(hubTwin.buildResponseCanonicalRaw(Object.assign({}, BASE, { effectiveTime: 1234 })), mirror);
                }
            });

            // Below the admission activation in this arm. When armed at 0 no regtest height is
            // below it, so those cases run on mainnet, where the response mirror is ALSO inert
            // and the request is therefore in the legacy attest era (no effective time at all).
            const legacyBlock = (arm.legacyBlock !== null) ? arm.legacyBlock : 5;
            const legacyNet   = (arm.legacyBlock !== null) ? NETWORK : 'mainnet';
            const legacyEt    = (arm.legacyBlock !== null) ? 1234 : null;
            const legacyTail  = (arm.legacyBlock !== null) ? '|1234' : BASE.meta;

            it('a request below the activation with no map rebuilds the pre-train bytes exactly as the hub does', function () {
                const got = indexerCanonical(h, Object.assign({}, BASE, { effectiveTime: legacyEt, network: legacyNet, requestBlock: legacyBlock, admitBlocks: null }), legacyBlock, legacyNet);
                assert.ok(got.endsWith(legacyTail), 'no admission field below the activation: ' + got.slice(-40));
                if (h.hub) assert.strictEqual(got, hubCanonical(h, legacyBlock, legacyEt, null, legacyNet));
            });

            if (arm.modernBlock !== null) {
                it('an admission-era request appends the request-block-keyed map after the effective time, equal to the hub', function () {
                    const fields = Object.assign({}, BASE, { effectiveTime: 1234, network: NETWORK, requestBlock: arm.modernBlock, admitBlocks: { BTC: arm.modernBlock + 1 } });
                    const got = indexerCanonical(h, fields, arm.modernBlock);
                    assert.ok(got.endsWith('|1234|BTC:' + (arm.modernBlock + 1)), got.slice(-40));
                    assert.strictEqual(got, hubCanonical(h, arm.modernBlock, 1234, { BTC: arm.modernBlock + 1 }));
                    // The map read back off a mirrored row's column is the same map.
                    const fromRow = h.act.columnsAdmitBlocks({ admit_block_btc: arm.modernBlock + 1 });
                    assert.strictEqual(indexerCanonical(h, Object.assign({}, fields, { admitBlocks: fromRow }), arm.modernBlock), got);
                });

                it('an admission-era request with no map REFUSES on both sides', function () {
                    assert.throws(() => h.can.buildResponseCanonicalRaw(Object.assign({}, BASE, { effectiveTime: 1234, network: NETWORK, requestBlock: arm.modernBlock })),
                        /AttestationConsensus: admission-era request|refusing to build a legacy canonical/);
                    assert.throws(() => h.can.buildResponseCanonicalRaw(Object.assign({}, BASE, { effectiveTime: 1234, network: NETWORK, requestBlock: arm.modernBlock, admitBlocks: null })),
                        /refusing to build a legacy canonical/);
                    if (h.hub) assert.throws(() => hubCanonical(h, arm.modernBlock, 1234, null), /refusing to build a legacy canonical/);
                    // A legacy row read back off the columns is null, which is the same refusal.
                    assert.strictEqual(h.act.columnsAdmitBlocks({ admit_block_btc: null }), null);
                });
            }

            it('a request below the activation handed a map REFUSES in the other direction', function () {
                assert.throws(() => h.can.buildResponseCanonicalRaw(Object.assign({}, BASE, { effectiveTime: legacyEt, network: legacyNet, requestBlock: legacyBlock, admitBlocks: { BTC: legacyBlock + 1 } })),
                    /refusing to build an admission-era canonical/);
                if (h.hub) assert.throws(() => hubCanonical(h, legacyBlock, legacyEt, { BTC: legacyBlock + 1 }, legacyNet), /refusing to build an admission-era canonical/);
            });

            it('the spelling guard on effective_time still throws before any admission field is considered', function () {
                assert.throws(() => h.can.buildResponseCanonicalRaw(Object.assign({}, BASE, { effectiveTime: '0120', network: NETWORK, requestBlock: 5, admitBlocks: null })),
                    /canonical integer spelling/);
            });
        });
    }
});

// ---------------------------------------------------------------------------
// The mirrored selects: SQL text pinned literally in both arms.
// ---------------------------------------------------------------------------

// The pre-train statements, verbatim from db.js and bridge_settle.js at the SHA this row
// was built on. A change to any of these below the activation is a consensus change.
const LEGACY_SQL = {
    matches: `SELECT * FROM cross_chain_matches
             WHERE status = 'finalized' AND network = ? AND effective_time <= ? AND (a_chain = ? OR b_chain = ?)
             ORDER BY snapshot_block ASC, match_id ASC`,
    dispatches: `SELECT * FROM cross_chain_calls
             WHERE phase = 'dispatch' AND status = 'finalized' AND network = ?
               AND target_chain = ? AND effective_time <= ?
             ORDER BY snapshot_block ASC, call_id ASC`,
    resultsSingleDb: `SELECT c.* FROM cross_chain_calls c
                 WHERE c.phase = 'result' AND c.status = 'finalized' AND c.network = ?
                   AND c.source_chain = ? AND c.effective_time <= ?
                   AND NOT EXISTS (
                       SELECT 1 FROM cross_chain_call_callbacks k WHERE k.call_id = c.call_id)
                 ORDER BY c.snapshot_block ASC, c.call_id ASC
                 LIMIT ?`,
    resultsRemote: `SELECT * FROM cross_chain_calls
             WHERE phase = 'result' AND status = 'finalized' AND network = ?
               AND source_chain = ? AND effective_time <= ?
             ORDER BY snapshot_block ASC, call_id ASC`,
    attest: `SELECT request_id, provider_id, status, response_payload, response_hash, meta,
                        effective_time, signer_pubkeys, signatures, widen, batch_action_index
                 FROM attestation_responses
                 WHERE network = ? AND effective_time <= ? AND request_id IN (?,?)`,
    transfers: `SELECT * FROM bridge_transfers
         WHERE status = 'finalized' AND network = ? AND effective_time <= ? AND dest_chain = ?
         ORDER BY snapshot_block ASC, transfer_id ASC`,
    policies: `SELECT * FROM policy_snapshots
         WHERE status = 'finalized' AND network = ? AND effective_time <= ?`
};

// The C33 form for a column, with the outer parentheses the selects compose it under.
const c33 = (col, p) => '((' + (p || '') + col + ' IS NULL AND ' + (p || '') + 'effective_time <= ?) OR (' +
                        (p || '') + col + ' IS NOT NULL AND ' + (p || '') + col + ' <= ?))';

// A never-bare check: the only `<col> <= ?` in the statement is the one inside the IS NOT
// NULL arm, so a bare comparison on the nullable column cannot slip in beside it.
function assertNeverBare(sql, col) {
    const bare = sql.split(col + ' <= ?').length - 1;
    const guarded = sql.split(col + ' IS NOT NULL AND ' + col + ' <= ?').length - 1;
    assert.strictEqual(bare, 1, 'exactly one height comparison: ' + sql);
    assert.strictEqual(guarded, 1, 'and it is inside the IS NOT NULL arm: ' + sql);
    assert.ok(sql.indexOf(col + ' IS NULL AND ') !== -1, 'the IS NULL legacy arm must be present: ' + sql);
}

function stubDb(h, coin, opts) {
    const o = opts || {};
    const indexer = { config: { COIN: coin, NETWORK: NETWORK }, util: null };
    const db = new h.Database('127.0.0.1', 3306, 'xchain_test', 'u', 'p', indexer);
    const captured = [];
    // The consensus readers go through doQueryStrict, which reaches the pool directly rather
    // than through doQuery, so both entry points capture.
    db.doQuery = async (sql, args) => { captured.push({ sql, args }); return []; };
    db.doQueryStrict = db.doQuery;
    if (o.remoteMirror) {
        const remoteQuery = async (sql, args) => { captured.push({ sql, args, remote: true }); return []; };
        indexer.hubDb = { doQuery: remoteQuery, doQueryStrict: remoteQuery };
    }
    return { db, captured };
}

describe('admission binding: the mirrored selects issue the C33 form above the activation and today\'s text below it', function () {

    const T = 1700000000;

    for (const arm of ARMS) {
        describe(arm.name, function () {
            let h;
            before(function () { h = load(arm.activation); });
            after(function () { if (h) h.restore(); h = null; });

            // Below the activation in this arm: the inert arm at any height, and the realistic
            // arm at LEGACY_AT. There is no such height when armed at 0.
            const legacyHeights = arm.activation === null ? [0, LEGACY_AT, ADMIT_AT] : (arm.legacyBlock !== null ? [arm.legacyBlock] : []);

            for (const B of legacyHeights) {
                it('below the activation at B=' + B + ' every select is byte-identical to the pre-train statement', async function () {
                    const { db, captured } = stubDb(h, 'BTC');
                    await db.getEffectiveUnsettledMatches('BTC', T, 25, B);
                    await db.getEffectiveUndispatchedCalls('BTC', NETWORK, T, 25, B);
                    await db.getEffectiveUnprocessedCallResults('BTC', NETWORK, T, 25, B);
                    await db.getMirroredAttestationResponses(NETWORK, ['a'.repeat(64), 'b'.repeat(64)], T, B);
                    assert.strictEqual(captured[0].sql, LEGACY_SQL.matches);
                    assert.deepStrictEqual(captured[0].args, [NETWORK, T, 'BTC', 'BTC']);
                    assert.strictEqual(captured[1].sql, LEGACY_SQL.dispatches);
                    assert.deepStrictEqual(captured[1].args, [NETWORK, 'BTC', T]);
                    assert.strictEqual(captured[2].sql, LEGACY_SQL.resultsSingleDb);
                    assert.deepStrictEqual(captured[2].args, [NETWORK, 'BTC', T, 25]);
                    assert.strictEqual(captured[3].sql, LEGACY_SQL.attest);
                    assert.deepStrictEqual(captured[3].args, [NETWORK, T, 'a'.repeat(64), 'b'.repeat(64)]);
                    for (const c of captured) assert.ok(!/admit_block/.test(c.sql), 'no admission column may be named below the activation');

                    const remote = stubDb(h, 'BTC', { remoteMirror: true });
                    await remote.db.getEffectiveUnprocessedCallResults('BTC', NETWORK, T, 25, B);
                    assert.strictEqual(remote.captured[0].sql, LEGACY_SQL.resultsRemote);
                    assert.deepStrictEqual(remote.captured[0].args, [NETWORK, 'BTC', T]);
                    assert.strictEqual(remote.captured[0].remote, true);
                });

                it('below the activation at B=' + B + ' the bridge selects are byte-identical to the pre-train statements', async function () {
                    const captured = [];
                    const ctx = { indexerDb: { _mirrorDb: () => ({ doQuery: async (sql, args) => { captured.push({ sql, args }); return []; } }),
                                               doQuery: async () => [] },
                                  coin: 'DOGE', network: NETWORK, blockIndex: B, blockTime: T };
                    await h.BS.dueBridgeTransfers(ctx);
                    await h.BS.duePolicySnapshots(ctx);
                    assert.strictEqual(captured[0].sql, LEGACY_SQL.transfers);
                    assert.deepStrictEqual(captured[0].args, [NETWORK, T, 'DOGE']);
                    assert.strictEqual(captured[1].sql, LEGACY_SQL.policies);
                    assert.deepStrictEqual(captured[1].args, [NETWORK, T]);
                    assert.deepStrictEqual(h.BS.mirrorBindClause(ctx), { sql: 'effective_time <= ?', args: [T] });
                });
            }

            it('a select handed no height reads as below the activation (the pre-train call shape)', async function () {
                const { db, captured } = stubDb(h, 'BTC');
                await db.getEffectiveUnsettledMatches('BTC', T, 25);
                await db.getEffectiveUnsettledMatches('BTC', T, 25, null);
                assert.strictEqual(captured[0].sql, LEGACY_SQL.matches);
                assert.strictEqual(captured[1].sql, LEGACY_SQL.matches);
                assert.deepStrictEqual(h.BS.mirrorBindClause({ coin: 'DOGE', network: NETWORK, blockTime: T }), { sql: 'effective_time <= ?', args: [T] });
            });

            if (arm.modernBlock !== null) {
                const B = arm.modernBlock;

                it('above the activation at B=' + B + ' the match, call and attest selects take the C33 form on this chain\'s column', async function () {
                    const { db, captured } = stubDb(h, 'BTC');
                    await db.getEffectiveUnsettledMatches('BTC', T, 25, B);
                    await db.getEffectiveUndispatchedCalls('BTC', NETWORK, T, 25, B);
                    await db.getEffectiveUnprocessedCallResults('BTC', NETWORK, T, 25, B);
                    await db.getMirroredAttestationResponses(NETWORK, ['a'.repeat(64), 'b'.repeat(64)], T, B);

                    assert.strictEqual(captured[0].sql, LEGACY_SQL.matches.replace('effective_time <= ?', c33('admit_block_btc')));
                    assert.deepStrictEqual(captured[0].args, [NETWORK, T, B, 'BTC', 'BTC']);
                    assert.strictEqual(captured[1].sql, LEGACY_SQL.dispatches.replace('effective_time <= ?', c33('admit_block_btc')));
                    assert.deepStrictEqual(captured[1].args, [NETWORK, 'BTC', T, B]);
                    assert.strictEqual(captured[2].sql, LEGACY_SQL.resultsSingleDb.replace('c.effective_time <= ?', c33('admit_block_btc', 'c.')));
                    assert.deepStrictEqual(captured[2].args, [NETWORK, 'BTC', T, B, 25]);
                    // The attest read names the one column the hub stamps on this table and
                    // reads it back for the selector and the verifier.
                    assert.strictEqual(captured[3].sql, LEGACY_SQL.attest
                        .replace('batch_action_index', 'batch_action_index, admit_block_btc')
                        .replace('effective_time <= ?', c33('admit_block_btc')));
                    assert.deepStrictEqual(captured[3].args, [NETWORK, T, B, 'a'.repeat(64), 'b'.repeat(64)]);
                    for (const c of captured) assertNeverBare(c.sql, c.sql.indexOf('c.admit') !== -1 ? 'c.admit_block_btc' : 'admit_block_btc');

                    const remote = stubDb(h, 'BTC', { remoteMirror: true });
                    await remote.db.getEffectiveUnprocessedCallResults('BTC', NETWORK, T, 25, B);
                    assert.strictEqual(remote.captured[0].sql, LEGACY_SQL.resultsRemote.replace('effective_time <= ?', c33('admit_block_btc')));
                    assert.deepStrictEqual(remote.captured[0].args, [NETWORK, 'BTC', T, B]);
                });

                it('above the activation the column is THIS indexer\'s coin, spelled from config', async function () {
                    const { db, captured } = stubDb(h, 'DOGE');
                    await db.getEffectiveUnsettledMatches('DOGE', T, 25, B);
                    assert.strictEqual(captured[0].sql, LEGACY_SQL.matches.replace('effective_time <= ?', c33('admit_block_doge')));
                    assert.ok(captured[0].sql.indexOf('admit_block_btc') === -1);
                });

                it('above the activation at B=' + B + ' the bridge selects take the C33 form, the policy select with no chain clause', async function () {
                    const captured = [];
                    const ctx = { indexerDb: { _mirrorDb: () => ({ doQuery: async (sql, args) => { captured.push({ sql, args }); return []; } }),
                                               doQuery: async () => [] },
                                  coin: 'DOGE', network: NETWORK, blockIndex: B, blockTime: T };
                    await h.BS.dueBridgeTransfers(ctx);
                    await h.BS.duePolicySnapshots(ctx);
                    assert.strictEqual(captured[0].sql, LEGACY_SQL.transfers.replace('effective_time <= ?', c33('admit_block_doge')));
                    assert.deepStrictEqual(captured[0].args, [NETWORK, T, B, 'DOGE']);
                    assert.strictEqual(captured[1].sql, LEGACY_SQL.policies.replace('effective_time <= ?', c33('admit_block_doge')));
                    assert.deepStrictEqual(captured[1].args, [NETWORK, T, B]);
                    assert.ok(!/_chain = \?/.test(captured[1].sql), 'the policy select carries no chain clause at any height');
                    for (const c of captured) assertNeverBare(c.sql, 'admit_block_doge');
                });

                it('bridge_settle and db.js spell the clause identically for the same column', function () {
                    const { db } = stubDb(h, 'DOGE');
                    const fromDb = db._mirrorBindClause(T, B);
                    const fromBs = h.BS.mirrorBindClause({ coin: 'DOGE', network: NETWORK, blockIndex: B, blockTime: T });
                    assert.deepStrictEqual(fromBs, fromDb);
                    assert.strictEqual(fromDb.sql, c33('admit_block_doge'));
                    assert.deepStrictEqual(fromDb.args, [T, B]);
                });

                it('a string height is a height and a null one is not (Number(null) is 0)', async function () {
                    const { db, captured } = stubDb(h, 'BTC');
                    await db.getEffectiveUnsettledMatches('BTC', T, 25, String(B));
                    await db.getEffectiveUnsettledMatches('BTC', T, 25, null);
                    await db.getEffectiveUnsettledMatches('BTC', T, 25, undefined);
                    assert.ok(captured[0].sql.indexOf('admit_block_btc') !== -1, 'a digit string is a height');
                    assert.deepStrictEqual(captured[0].args, [NETWORK, T, B, 'BTC', 'BTC']);
                    assert.strictEqual(captured[1].sql, LEGACY_SQL.matches, 'null is not height 0');
                    assert.strictEqual(captured[2].sql, LEGACY_SQL.matches, 'undefined is not height 0');
                });
            }
        });
    }
});

// ---------------------------------------------------------------------------
// The attest-response bind predicate (utility.selectApplicableAttestationResponses).
// ---------------------------------------------------------------------------

describe('admission binding: the attest-response bind predicate', function () {

    const REQ_ID = 'd'.repeat(64);
    const T      = 1700000000;
    const request = (extra) => Object.assign({ request_id: REQ_ID, request_status: 'pending', deadline_block: 900000,
                                               block_index: 90, action_index: 11 }, extra || {});
    const mirror  = (extra) => Object.assign({ request_id: REQ_ID, effective_time: T, response_hash: 'a'.repeat(64) }, extra || {});

    for (const arm of ARMS) {
        describe(arm.name, function () {
            let h, util;
            before(function () { h = load(arm.activation); util = new h.Utility({ COIN: 'BTC', NETWORK: NETWORK }); });
            after(function () { if (h) h.restore(); h = null; });

            const sel = (rows, B, t, coin) => util.selectApplicableAttestationResponses(rows, [request()], B, t, NETWORK, coin);

            const legacyHeights = arm.activation === null ? [0, LEGACY_AT, ADMIT_AT] : (arm.legacyBlock !== null ? [arm.legacyBlock] : []);
            for (const B of legacyHeights) {
                it('below the activation at B=' + B + ' a row binds by effective_time <= t(B) and the column is ignored', function () {
                    assert.strictEqual(sel([mirror()], B, T).length, 1);
                    assert.strictEqual(sel([mirror()], B, T - 1).length, 0, 'one second short of the effective time');
                    // A column that would refuse above the activation changes nothing below it.
                    assert.strictEqual(sel([mirror({ admit_block_btc: B + 1 })], B, T).length, 1);
                    assert.strictEqual(sel([mirror({ admit_block_btc: B - 1 })], B, T - 1).length, 0);
                });
            }

            if (arm.modernBlock !== null) {
                const B = arm.modernBlock;

                it('above the activation at B=' + B + ' a row with a height binds by admit_block_btc <= B, not by the clock', function () {
                    assert.strictEqual(sel([mirror({ admit_block_btc: B })], B, T - 1).length, 1, 'the clock no longer holds a row whose height has arrived');
                    assert.strictEqual(sel([mirror({ admit_block_btc: B + 1 })], B, T + 100).length, 0, 'the clock no longer admits a row whose height has not');
                    assert.strictEqual(sel([mirror({ admit_block_btc: B + 1 })], B + 1, T - 1).length, 1);
                });

                it('above the activation a row with NO height binds by the legacy clock rule (C38)', function () {
                    assert.strictEqual(sel([mirror()], B, T).length, 1);
                    assert.strictEqual(sel([mirror({ admit_block_btc: null })], B, T).length, 1);
                    assert.strictEqual(sel([mirror({ admit_block_btc: null })], B, T - 1).length, 0);
                });

                it('above the activation the deadline, pending and mirror-era clauses still hold', function () {
                    const past = [request({ deadline_block: B - 1 })];
                    assert.strictEqual(util.selectApplicableAttestationResponses([mirror({ admit_block_btc: B })], past, B, T, NETWORK, 'BTC').length, 0);
                    const done = [request({ request_status: 'fulfilled' })];
                    assert.strictEqual(util.selectApplicableAttestationResponses([mirror({ admit_block_btc: B })], done, B, T, NETWORK, 'BTC').length, 0);
                });

                it('above the activation the tie-break still picks the smaller signed effective_time', function () {
                    const items = sel([mirror({ admit_block_btc: B, effective_time: T + 5, response_hash: 'b'.repeat(64) }),
                                       mirror({ admit_block_btc: B, effective_time: T + 1, response_hash: 'c'.repeat(64) })], B, T - 1);
                    assert.strictEqual(items.length, 1);
                    assert.strictEqual(items[0].response.effective_time, T + 1);
                });

                it('the activation is keyed on (coin, network): a coin the map does not know reads inert', function () {
                    // regtest arms every known coin from one env, so the negative case is a
                    // coin the map has no key for, which must read inert rather than armed.
                    assert.strictEqual(sel([mirror({ admit_block_btc: B + 1 })], B, T, 'XYZ').length, 1,
                        'an unknown coin is inert: the clock rule binds and the column is ignored');
                    assert.strictEqual(util.selectApplicableAttestationResponses([mirror({ admit_block_btc: B + 1 })], [request()], B, T, 'mainnet', 'BTC').length, 0,
                        'mainnet is inert at every height in this train, and the mirror-era clause refuses the request there');
                });

                it('a null block index is not height 0: it reads inert, never armed', function () {
                    // Number(null) is 0 and 0 is above an activation armed at 0. The predicate
                    // keys the era on the RAW block index, so null cannot arm it.
                    assert.strictEqual(util.selectApplicableAttestationResponses([mirror({ admit_block_btc: 5 })], [request({ deadline_block: 10 })], null, T - 1, NETWORK, 'BTC').length, 0,
                        'inert at a null height means the clock rule, which T-1 fails');
                });
            }
        });
    }

    describe('the applier pass threads the block index and the coin into both halves of the read', function () {
        let h;
        before(function () { h = load(null); });
        after(function () { if (h) h.restore(); h = null; });

        it('passes block_index to the mirror read and the coin to the selector', async function () {
            const util = new h.Utility({ COIN: 'BTC', NETWORK: NETWORK });
            const db = {
                config: { COIN: 'BTC', NETWORK: NETWORK },
                getAttestationRequestsAwaitingMirrorResponse: sinon.stub().resolves([request()]),
                getMirroredAttestationResponses: sinon.stub().resolves([mirror()])
            };
            const select = sinon.spy(util, 'selectApplicableAttestationResponses');
            const actions = { processAction: sinon.stub().resolves() };
            await util.processAttestationResponses(actions, db, 100, T);
            assert.deepStrictEqual(db.getMirroredAttestationResponses.firstCall.args, [NETWORK, [REQ_ID], T, 100]);
            assert.strictEqual(select.firstCall.args[2], 100);
            assert.strictEqual(select.firstCall.args[5], 'BTC');
        });

        it('the settle and call passes pass block_index to their reads', async function () {
            const util = new h.Utility({ COIN: 'BTC', NETWORK: NETWORK });
            const db = {
                config: { COIN: 'BTC', NETWORK: NETWORK },
                getEffectiveUnsettledMatches: sinon.stub().resolves([]),
                getEffectiveUndispatchedCalls: sinon.stub().resolves([]),
                getExpiredCrossChainCallRequests: sinon.stub().resolves([]),
                getEffectiveUnprocessedCallResults: sinon.stub().resolves([])
            };
            const actions = { protocolChanges: { isEnabled: async () => true }, processAction: sinon.stub().resolves(),
                              actionXcall: { processResult: sinon.stub().resolves() } };
            await util.processCrossChainSettlements(actions, db, 4242, T);
            assert.strictEqual(db.getEffectiveUnsettledMatches.firstCall.args[3], 4242);
            await util.processCrossChainCalls(actions, db, 4242, T);
            assert.strictEqual(db.getEffectiveUndispatchedCalls.firstCall.args[4], 4242);
            assert.strictEqual(db.getEffectiveUnprocessedCallResults.firstCall.args[4], 4242);
        });
    });
});

// ---------------------------------------------------------------------------
// The direct-hub-DB call-presence member (XChainIndexer._waitForDirectCallPresence).
// ---------------------------------------------------------------------------

describe('admission binding: the direct-hub-DB call-presence member', function () {

    const { HUB_SYNC_WATERMARK_GRACE_S } = require('../../src/hub_db_sync.js');
    const GRACE = HUB_SYNC_WATERMARK_GRACE_S.call;
    const NOW_S = () => Math.floor(Date.now() / 1000);
    const FLOOR_SQL = "SELECT param_value FROM configs WHERE coin = ? AND network = ? AND module = ? AND param_name = ?";
    const COVERAGE_SQL = "SELECT MAX(effective_time) AS ts, UNIX_TIMESTAMP() AS hub_now " +
                         "FROM cross_chain_calls WHERE status = 'finalized' AND (target_chain = ? OR source_chain = ?)";

    // A harness in the shape the existing directCallPresence suite uses, plus the config
    // and the activation reader the height form reaches.
    function ctx(h, opts) {
        const o = opts || {};
        const captured = [];
        const doQuery = sinon.stub().callsFake(async (sql, args) => {
            captured.push({ sql, args });
            if (o.fail) throw new Error(o.fail);
            return typeof o.rows === 'function' ? o.rows(sql, args) : (o.rows || []);
        });
        const self = {
            hubDb: o.noHubDb ? null : { doQuery, doQueryStrict: doQuery },
            config: o.noConfig ? undefined : { COIN: o.coin || 'BTC', NETWORK: NETWORK },
            callPresenceTimeoutMs: o.timeoutMs != null ? o.timeoutMs : 40,
            directCallGraceS: o.graceS,
            util: { sleep: (ms) => sleep(ms), throwError: (msg) => { throw new Error(msg); } },
            _mirrorAdmissionActiveAt: h.Indexer.prototype._mirrorAdmissionActiveAt,
            captured
        };
        return self;
    }
    const run      = (h, self, bt, B) => h.Indexer.prototype._waitForDirectCallPresence.call(self, bt, B);
    const clearsAt = (h, self, bt, B) => h.Indexer.prototype._directCallBarrierClearsAt.call(self, bt, B);
    const floorRow = (v) => [{ param_value: v }];

    for (const arm of ARMS) {
        describe(arm.name, function () {
            let h;
            before(function () { h = load(arm.activation); });
            after(function () { if (h) h.restore(); h = null; });

            const legacyHeights = arm.activation === null ? [0, LEGACY_AT, ADMIT_AT] : (arm.legacyBlock !== null ? [arm.legacyBlock] : []);
            for (const B of legacyHeights) {
                it('below the activation at B=' + B + ' the coverage read is the clock form, scoped to this coin', async function () {
                    const bt = NOW_S() + 3600;
                    const self = ctx(h, { rows: [{ ts: bt, hub_now: NOW_S() }] });
                    await run(h, self, bt, B);
                    assert.strictEqual(self.captured.length, 1);
                    assert.strictEqual(self.captured[0].sql, COVERAGE_SQL);
                    assert.deepStrictEqual(self.captured[0].args, ['BTC', 'BTC']);
                });

                it('below the activation at B=' + B + ' the hub-clock escape still opens and the verdict is the clock instant', async function () {
                    const bt = NOW_S() - 500;
                    const self = ctx(h, { rows: [{ ts: bt - 100, hub_now: bt + GRACE }] });
                    await run(h, self, bt, B);
                    assert.strictEqual(self.captured.length, 1, 'the escape opens on the first poll');
                    assert.strictEqual(clearsAt(h, ctx(h, {}), bt, B), (bt + GRACE) * 1000);
                });

                it('below the activation at B=' + B + ' the floor is never read', async function () {
                    const bt = NOW_S() + 3600;
                    const self = ctx(h, { rows: [{ ts: bt - 1, hub_now: NOW_S() }] });
                    await assert.rejects(() => run(h, self, bt, B), /direct call-presence barrier timed out after 40ms waiting for block_time/);
                    for (const c of self.captured) assert.ok(!/configs/.test(c.sql));
                });
            }

            it('the one-argument shape stays inert and never touches config (the pre-train harness)', async function () {
                const bt = NOW_S() + 3600;
                const self = ctx(h, { rows: [{ ts: bt, hub_now: NOW_S() }], noConfig: true });
                delete self._mirrorAdmissionActiveAt;
                await run(h, self, bt);
                assert.strictEqual(self.captured[0].sql, COVERAGE_SQL.replace(" AND (target_chain = ? OR source_chain = ?)", ''),
                    'no coin configured: the unscoped superset');
                assert.deepStrictEqual(self.captured[0].args, []);
                assert.strictEqual(clearsAt(h, self, bt), (bt + GRACE) * 1000);
                assert.strictEqual(clearsAt(h, self, bt, undefined), (bt + GRACE) * 1000);
                assert.strictEqual(clearsAt(h, self, bt, null), (bt + GRACE) * 1000);
            });

            if (arm.modernBlock !== null) {
                const B = arm.modernBlock;
                // The margin is a frozen constant of the twin, the same in every arm.
                const target = B - require('../../src/mirror_admission_activation.js').admitMarginBlocks('cross_chain_calls');

                // A persisted floor is canonical digits, so it is never negative: at B=0 the
                // target is below genesis, every real floor covers it, and the only NOT-covered
                // readings are the unusable ones (the Number(null) trap case below).
                const covering = String(Math.max(target, 0));
                const short    = (target >= 1) ? String(target - 1) : null;

                it('above the activation at B=' + B + ' coverage is the persisted floor at or above B - margin, read from configs', async function () {
                    const bt = NOW_S() + 7200;                        // a far-future stamp holds nothing here
                    const self = ctx(h, { rows: floorRow(covering) });
                    await run(h, self, bt, B);
                    assert.strictEqual(self.captured.length, 1);
                    assert.strictEqual(self.captured[0].sql, FLOOR_SQL);
                    assert.deepStrictEqual(self.captured[0].args, ['xchain', NETWORK, 'admission_watermark', 'cross_chain_calls.BTC']);
                    // One more than needed also covers; one short does not.
                    await run(h, ctx(h, { rows: floorRow(String(Number(covering) + 1)) }), bt, B);
                    if (short !== null)
                        await assert.rejects(() => run(h, ctx(h, { rows: floorRow(short) }), bt, B),
                            /timed out after 40ms waiting for block_time/);
                });

                it('above the activation the hub-clock escape is retired and t(B) is never read', async function () {
                    const bt = NOW_S() - 100000;                      // a stamp far in the past would open every clock escape
                    const self = ctx(h, { rows: short !== null ? floorRow(short) : [] });
                    await assert.rejects(() => run(h, self, bt, B), /timed out/);
                    for (const c of self.captured) {
                        assert.strictEqual(c.sql, FLOOR_SQL);
                        assert.ok(!/UNIX_TIMESTAMP|effective_time/.test(c.sql));
                    }
                    assert.strictEqual(clearsAt(h, ctx(h, {}), bt, B), null, 'no clock instant opens a height-keyed barrier (C8)');
                });

                it('above the activation an absent row, a non-digit value, a null value and a query error all read as NOT covered', async function () {
                    const bt = NOW_S();
                    for (const rows of [[], floorRow(null), floorRow(undefined), floorRow('abc'), floorRow('0' + covering), floorRow(' '), floorRow('-1'), floorRow('1e21')]) {
                        await assert.rejects(() => run(h, ctx(h, { rows }), bt, B), /timed out/, 'covered on ' + JSON.stringify(rows));
                    }
                    await assert.rejects(() => run(h, ctx(h, { fail: 'table missing' }), bt, B), /timed out[\s\S]*\[last query error: table missing\]/);
                });

                if (B === 0) {
                    it('armed at 0, a null floor at a negative target is still NOT covered (Number(null) is 0, and 0 >= -4)', async function () {
                        assert.ok(target < 0, 'the target below genesis is what makes this case bite');
                        await assert.rejects(() => run(h, ctx(h, { rows: floorRow(null) }), NOW_S(), B), /timed out/);
                        await assert.rejects(() => run(h, ctx(h, { rows: [] }), NOW_S(), B), /timed out/);
                        // While a real floor of 0 does cover a negative target.
                        await run(h, ctx(h, { rows: floorRow('0') }), NOW_S(), B);
                    });
                }

                it('above the activation the timeout keeps its byte-identical prefix and appends the height form', async function () {
                    const bt = NOW_S();
                    let msg = '';
                    const prefix = 'direct call-presence barrier timed out after 40ms waiting for block_time ' + bt +
                                   ' (call mirror at null, hub clock at null, escape at ' + (bt + GRACE) + ')';
                    if (target >= 3) {
                        try { await run(h, ctx(h, { rows: floorRow(String(target - 3)) }), bt, B); } catch (e) { msg = e.message; }
                        assert.ok(msg.startsWith(prefix), msg);
                        assert.strictEqual(msg.slice(prefix.length), ' (admission height cross_chain_calls.BTC at ' + (target - 3) + ', needs ' + target + ')');
                    }
                    try { await run(h, ctx(h, { rows: [] }), bt, B); } catch (e) { msg = e.message; }
                    assert.ok(msg.startsWith(prefix), msg);
                    assert.strictEqual(msg.slice(prefix.length), ' (admission height cross_chain_calls.BTC at none, needs ' + target + ')');
                });

                it('above the activation the floor is read for THIS coin', async function () {
                    const self = ctx(h, { coin: 'DOGE', rows: floorRow(covering) });
                    await run(h, self, NOW_S(), B);
                    assert.deepStrictEqual(self.captured[0].args, ['xchain', NETWORK, 'admission_watermark', 'cross_chain_calls.DOGE']);
                });

                it('above the activation a string height is a height, so the caller cannot pass one and read inert', async function () {
                    const self = ctx(h, { rows: floorRow(covering) });
                    await run(h, self, NOW_S(), String(B));
                    assert.strictEqual(self.captured[0].sql, FLOOR_SQL);
                });
            }
        });
    }
});

'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// EQUIV header: cross-chain call (XCALL) round-trip.
// CONSENSUS-CRITICAL: the dispatch canonical (xexec.canonical) and the result
// canonical (xcall.resultCanonical) are rebuilt to re-verify quorum sigs and MUST
// byte-match the hub CrossChainCallEngine.canonicalMatch + the archive/recovery
// twins. XCALL is view-bearing (VIEW = finalizing_view). The ROUND_ID folds in the
// phase (sha256('XCALLROUND|'+phase+'|'+call_id)), so dispatch and result get DISTINCT
// equivocation keys: a validator legitimately signing both is NOT slashable.
const assert = require('assert');
const crypto = require('crypto');
const eq = require('../../../src/equivocation_header.js');

// THE LEGACY ARM, EXPLICITLY. The rows below carry no admission columns, which is a legacy
// row only while the mirror-admission activation is inert; a process launched armed
// (XC_MIRROR_ADMISSION_ACTIVATION set) makes both canonicals REFUSE them, correctly, so the
// two action modules are required with the env unset and the cache put back at once. This
// file drives the legacy bytes; admission_binding.test.js drives the armed arm of the same
// twins against the hub's builders. Same purge/re-require idiom as the price suites (row 25).
function requireDisarmed(mods){
    const paths = ['../../../src/mirror_admission_activation.js'].concat(mods).map(m => require.resolve(m));
    const saved = paths.map(p => [p, require.cache[p]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    for (const p of paths) delete require.cache[p];
    try {
        return mods.map(m => require(m));
    } finally {
        for (const [p, m] of saved) { if (m === undefined) delete require.cache[p]; else require.cache[p] = m; }
        if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    }
}
// xexec requires xcall, so xcall is purged first and both are re-required in one pass.
const [Xcall, Xexec] = requireDisarmed(['../../../src/actions/xcall/index.js', '../../../src/actions/xexec/index.js']);

const mkAction = () => ({ config:{}, decoderDb:null, indexerDb:null, util:null, mapper:null });
const xexec = new Xexec(mkAction());
const xcall = new Xcall(mkAction());
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const CID = 'c'.repeat(64);

function dispatchRow(network, block, view){
    return { call_id:CID, phase:'dispatch', snapshot_block:block, network:network,
        source_chain:'BTC', source_action_index:10, source_contract_index:2,
        target_chain:'LTC', target_contract_index:3, method:'transfer',
        params_json:'["x"]', gas_limit:1000000, cross_hops:0, effective_time:1700000000,
        finalizing_view:view };
}
function resultRow(network, block, view){
    return { call_id:CID, phase:'result', snapshot_block:block, network:network,
        target_chain:'LTC', result_status:'ok', return_payload_b64:'cmVz', effective_time:1700000000,
        finalizing_view:view };
}
const RAW_D = 'XCALL|DISPATCH|' + CID + '|100|regtest|BTC|10|2|LTC|3|transfer|' + sha('["x"]') + '|1000000|0|1700000000';
const RAW_R = 'XCALL|RESULT|' + CID + '|100|regtest|LTC|ok|' + sha('cmVz') + '|1700000000';

describe('EQUIV XCALL canonical (WI-2 bump 2)', function () {

    it('dispatch below the flag-day (mainnet) → bare bytes', function () {
        const raw = RAW_D.replace('|100|regtest|', '|5|mainnet|');
        assert.strictEqual(xexec.canonical(dispatchRow('mainnet', 5, 0)), raw);
    });

    it('dispatch at/above the flag-day → header-wrapped (ROUND_ID folds in phase, VIEW=finalizing_view)', function () {
        const rid = sha('XCALLROUND|dispatch|' + CID);
        assert.strictEqual(xexec.canonical(dispatchRow('regtest', 100, 0)), 'EQUIV|XCALL|' + rid + '|0||' + RAW_D);
        assert.strictEqual(xexec.canonical(dispatchRow('regtest', 100, 2)), 'EQUIV|XCALL|' + rid + '|2||' + RAW_D);
    });

    it('result at/above the flag-day → header-wrapped with its OWN round id', function () {
        const rid = sha('XCALLROUND|result|' + CID);
        assert.strictEqual(xcall.resultCanonical(resultRow('regtest', 100, 0)), 'EQUIV|XCALL|' + rid + '|0||' + RAW_R);
    });

    it('dispatch and result of the same call carry DISTINCT keys (no false equivocation)', function () {
        const keyOf = (c) => c.slice('EQUIV|'.length, c.indexOf('||'));
        const kd = keyOf(xexec.canonical(dispatchRow('regtest', 100, 0)));
        const kr = keyOf(xcall.resultCanonical(resultRow('regtest', 100, 0)));
        assert.notStrictEqual(kd, kr);
        assert.strictEqual(kd, 'XCALL|' + sha('XCALLROUND|dispatch|' + CID) + '|0');
        assert.strictEqual(kr, 'XCALL|' + sha('XCALLROUND|result|' + CID) + '|0');
    });

    it('is driven in the legacy arm: a row handed admission columns is refused in BOTH phases', function () {
        // Proves the disarm above took, so the byte assertions here cannot pass vacuously in
        // a process that happened to be launched unarmed, and shows the era gate is wired
        // into both twins rather than one.
        const cols = { admit_block_btc: 104, admit_block_ltc: 404 };
        assert.throws(() => xexec.canonical(Object.assign(dispatchRow('regtest', 100, 0), cols)),
                      /refusing to build an admission-era canonical/);
        assert.throws(() => xcall.resultCanonical(Object.assign(resultRow('regtest', 100, 0), cols)),
                      /refusing to build an admission-era canonical/);
        // NULL columns are the legacy row, byte for byte.
        const nulls = { admit_block_btc: null, admit_block_ltc: null, admit_block_doge: null };
        assert.strictEqual(xexec.canonical(Object.assign(dispatchRow('regtest', 100, 0), nulls)),
                           xexec.canonical(dispatchRow('regtest', 100, 0)));
    });
});

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
 * The arming loader for the admission-binding suite (test/unit/admission_binding.test.js
 * and its parts): the arming heights, the hub sibling verdict, the purge-and-re-require
 * load() every block calls from its before hook, and the three arms every block runs under.
 *
 ********************************************************************/

'use strict';

const path = require('path');
const { siblingCheckout, siblingsRequired } = require('../../../../helpers/sibling_checkout.js');

const NETWORK   = 'regtest';
const ADMIT_AT  = 799000;                       // the realistic arming height
const LEGACY_AT = ADMIT_AT - 1;

const HUB_SRC  = path.resolve(__dirname, '../../../../../../xchain-hub/src');
// Present is not enough to trust: in a lane worktree the hub entry can be a symlink into a
// peer's live main checkout, which no commit pins, so the shared helper decides. Probed on
// the admission gate at its W5 tail, so a hub checkout that predates the move reads as
// absent (skip, or a refusal under XCHAIN_REQUIRE_SIBLINGS=1) rather than as a resolve error.
const HUB_VERDICT = siblingCheckout(__dirname, path.join(HUB_SRC, 'consensus', 'gates', 'mirror_admission_gate.js'));
const HAVE_HUB = HUB_VERDICT.usable;
if (!HAVE_HUB && siblingsRequired())
    throw new Error('admission binding parity cannot run: xchain-hub sibling at ' + HUB_SRC + ' refused: ' + HUB_VERDICT.reason);

// Every module that captures a function off the activation twin at require time, so an
// arming has to purge and re-require all of them or the consumer keeps the old arm.
const LOCAL_MODULES = [
    '../../../../../src/consensus/gates/mirror_admission_gate.js',
    '../../../../../src/consensus/attest_response_canonical.js',
    '../../../../../src/actions/xcall/index.js',
    '../../../../../src/actions/xexec/index.js',
    '../../../../../src/actions/cross_settle/index.js',
    '../../../../../src/consensus/bridge_settle.js',
    '../../../../../src/db',
    '../../../../../src/utility.js',
    '../../../../../src/XChainIndexer.js'
];
const HUB_MODULES = [
    '../../../../../../xchain-hub/src/consensus/gates/mirror_admission_gate.js',
    '../../../../../../xchain-hub/src/lib/admission_height.js',
    '../../../../../../xchain-hub/src/cross_chain/dex_engine.js',
    '../../../../../../xchain-hub/src/cross_chain/call_engine.js',
    '../../../../../../xchain-hub/src/cross_chain/bridge_engine.js',
    '../../../../../../xchain-hub/src/attestation/consensus.js'
];
// A listed module is only its ENTRY. Both services assemble a long module from part files
// beside it, under a directory spelled exactly as the entry (src/db/database/*.js here,
// xchain-hub/src/attestation/consensus/canonical.js and lib/admission_height/read_sets.js
// there), and a part captures the activation twin at its OWN load. Purging the entry alone
// re-requires a shell whose parts still hold the previous arm, which is how an armed case
// came back refusing an admission-era canonical the hub was armed for. So every listed
// module's part tree is purged by prefix, the entry's own directory when the entry is an
// index.js and the same-stem directory otherwise. An unsplit module has no such directory
// and contributes nothing.
function partTreeOf(resolved) {
    const dir = path.basename(resolved) === 'index.js'
        ? path.dirname(resolved)
        : resolved.replace(/\.js$/, '');
    return dir === resolved ? null : dir + path.sep;
}
function purgedTrees(listed) {
    return listed.map(partTreeOf).filter(Boolean);
}
const underPartTree = (p, trees) => trees.some(t => p.startsWith(t));

// Purge, arm (or disarm), re-require, and hand back everything a case needs plus the
// restore that puts the process back exactly as it was.
function load(activation) {
    const listed = LOCAL_MODULES.map(m => require.resolve(m))
        .concat(HAVE_HUB ? HUB_MODULES.map(m => require.resolve(m)) : []);
    const trees = purgedTrees(listed);
    const paths = listed.concat(
        Object.keys(require.cache).filter(p => underPartTree(p, trees) && !listed.includes(p)));
    const saved    = paths.map(p => [p, require.cache[p]]);
    const savedEnv = process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    for (const p of paths) delete require.cache[p];
    if (activation === null) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
    else process.env.XC_MIRROR_ADMISSION_ACTIVATION = String(activation);

    const h = {
        activation,
        act:      require('../../../../../src/consensus/gates/mirror_admission_gate.js'),
        can:      require('../../../../../src/consensus/attest_response_canonical.js'),
        Xcall:    require('../../../../../src/actions/xcall/index.js'),
        Xexec:    require('../../../../../src/actions/xexec/index.js'),
        Settle:   require('../../../../../src/actions/cross_settle/index.js'),
        BS:       require('../../../../../src/consensus/bridge_settle.js'),
        Database: require('../../../../../src/db'),
        Utility:  require('../../../../../src/utility.js'),
        Indexer:  require('../../../../../src/XChainIndexer.js'),
        hub:      null
    };
    if (HAVE_HUB) {
        h.hub = {
            act:    require('../../../../../../xchain-hub/src/consensus/gates/mirror_admission_gate.js'),
            ah:     require('../../../../../../xchain-hub/src/lib/admission_height.js'),
            Dex:    require('../../../../../../xchain-hub/src/cross_chain/dex_engine.js'),
            Call:   require('../../../../../../xchain-hub/src/cross_chain/call_engine.js'),
            Bridge: require('../../../../../../xchain-hub/src/cross_chain/bridge_engine.js'),
            Attest: require('../../../../../../xchain-hub/src/attestation/consensus.js')
        };
    }
    h.restore = function () {
        // Drop what the armed load cached under every purged part tree too, so the tree is
        // exactly as found.
        for (const p of Object.keys(require.cache)) if (underPartTree(p, trees)) delete require.cache[p];
        for (const [p, mod] of saved) {
            if (mod === undefined) delete require.cache[p]; else require.cache[p] = mod;
        }
        if (savedEnv === undefined) delete process.env.XC_MIRROR_ADMISSION_ACTIVATION;
        else process.env.XC_MIRROR_ADMISSION_ACTIVATION = savedEnv;
    };
    return h;
}

// The three arms every describe below runs under. `legacyBlock` is a regtest height that
// is BELOW the activation in that arm (none exists when armed at 0, so those cases use
// mainnet, which is inert at every height in this train); `modernBlock` is at/above it.
const ARMS = [
    { name: 'INERT (no env)',           activation: null,     modernBlock: null,     legacyBlock: LEGACY_AT },
    { name: 'ARMED at height 0',        activation: 0,        modernBlock: 0,        legacyBlock: null },
    { name: 'ARMED at height ' + ADMIT_AT, activation: ADMIT_AT, modernBlock: ADMIT_AT, legacyBlock: LEGACY_AT }
];

module.exports = { NETWORK, ADMIT_AT, LEGACY_AT, HAVE_HUB, load, ARMS };

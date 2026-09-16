/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC, https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available; contact
 * legal@dankest.llc.
 *
 **********************************************************************
 * test/unit/consensus/consensus_rules_digest.test.js
 *
 * The indexer half of the cross-repo consensus-rules digest. The alarm logic
 * lives on the hub (it is the side that gossips), so this file guards the two
 * things the indexer owns: that its copy resolves every shared gate, and that
 * the digest it publishes on /health is the one a hub would compare against.
 */

'use strict';

// Decides whether the hub twin path may be trusted before the digest compare reads it.
const {
    assert, fs, path, crd, siblingCheckout, skipOrFail
} = require('./consensus_rules_digest.test/helpers/consensus_rules_digest.js');

const HUB_COPY = path.resolve(__dirname, '../../../../xchain-hub/src/consensus_rules_digest.js');

describe('consensus_rules_digest (indexer copy)', function () {

    it('resolves every shared gate in this repo, none absent', function () {
        const { gates } = crd.computeConsensusRulesDigest();
        const absent = Object.keys(gates).filter(k => gates[k] === crd.ABSENT);
        assert.deepStrictEqual(absent, [], 'unresolved gates: ' + absent.join(', '));
        const expected = crd.SHARED_GATES.reduce((n, g) => n + g[1].length, 0);
        assert.strictEqual(Object.keys(gates).length, expected);
    });

    // The point of a value-based digest rather than a file fingerprint: the hub and
    // the indexer share no source file, so armed_map_fingerprint can never match
    // between them, while this must.
    it('is identical to the hub copy gate for gate', function () {
        // Refuses an absent hub and a lane symlink into a live main checkout alike. The hub
        // copy cannot compute without its admission carrier at the W5 tail, so a hub tree
        // that predates the move is probed on that file and skips (or refuses under
        // XCHAIN_REQUIRE_SIBLINGS=1) rather than throwing out of the twin's loader.
        const hubCheckout = siblingCheckout(__dirname, HUB_COPY);
        if (!hubCheckout.usable) return skipOrFail(this, hubCheckout, 'the xchain-hub consensus_rules_digest twin');
        const hubCarrier = siblingCheckout(__dirname, path.resolve(HUB_COPY, '..', 'consensus', 'gates', 'mirror_admission_gate.js'));
        if (!hubCarrier.usable) return skipOrFail(this, hubCarrier, 'the xchain-hub admission carrier the digest twin reads');
        const hub = require(HUB_COPY);
        const mine = crd.computeConsensusRulesDigest();
        const theirs = hub.computeConsensusRulesDigest();
        assert.deepStrictEqual(crd.diffGates(mine.gates, theirs.gates), [],
            'gates disagreeing between indexer and hub');
        assert.strictEqual(theirs.digest, mine.digest);
        // And the two SHARED_GATES registries must list the same gates in the same
        // order: the order is part of the preimage, so a reordered copy would digest
        // differently even with every value equal.
        assert.deepStrictEqual(hub.SHARED_GATES, crd.SHARED_GATES);
    });

    it('publishes the digest on the health payload beside the file fingerprint', function () {
        const src = fs.readFileSync(path.resolve(__dirname, '../../../src/api/health.js'), 'utf8');
        assert.ok(/consensus_rules_digest:\s*computeConsensusRulesDigest\(\)\.digest/.test(src),
            'health.js must publish consensus_rules_digest');
        assert.ok(/armed_map_fingerprint:/.test(src),
            'the file fingerprint must stay: the two answer different questions');
    });

    it('changes when a height changes and not when prose does', function () {
        const a = crd.canonical({ mainnet: null, testnet: 151200, regtest: 0 });
        const b = crd.canonical({ regtest: 0, testnet: 151200, mainnet: null });
        assert.strictEqual(a, b, 'key order must not matter');
        assert.notStrictEqual(a, crd.canonical({ mainnet: null, testnet: 151201, regtest: 0 }));
    });
});

// A registry row this build LACKS, a carrier that is gone and a carrier that is here and
// will not load are three different defects, and none of them has a digest. The value of
// every shared gate is a registry row now, so a missing row is a build defect that throws
// naming the key rather than reading ABSENT: the null the old loader returned let a moved
// carrier read as ABSENT while the signed GATES field stayed byte for byte what every peer
// publishes. The load refusal is not cosmetic either: src/consensus/gates/mirror_admission_gate.js
// is the one carrier still read (for its function-valued gates), and a checkout that cannot
// load a carrier must refuse rather than round down, since two revisions measured that
// way agree with each other while agreeing with no real build.
//
// Driven against a COPY of the real module in a scratch directory, with a registry that
// wraps the real one and one generated stub per SHARED_GATES carrier, because __dirname
// is what the loader resolves against: the cases have to be able to drop a row and break
// a carrier, which no real checkout may do. The hub copy carries the same cases.
const os = require('os');
const MODULE_SRC   = path.resolve(__dirname, '../../../src/consensus_rules_digest.js');
const REGISTRY_SRC = path.resolve(__dirname, '../../../src/consensus/gate_registry.js');

// A standalone tree: the module under test, a registry that answers from the real one
// except for `missingKey` (a RegistryMissError, exactly what a dropped row raises), and a
// stub for every carrier the module names (a function under every name that is a
// function on the real carrier, since only those are read from the carrier). The
// stubs sit where the loader looks since W5, consensus/gates/<stem>_gate.js; a
// SHARED_GATES module with no logic module left (a W5-deleted predicate shim)
// gets a values-only stub the loader never opens.
function carrierPath(mod) { return path.join('consensus', 'gates', mod.replace(/_activation$/, '_gate') + '.js'); }
function scratchTree(mutate, missingKey) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-carrier-'));
    fs.copyFileSync(MODULE_SRC, path.join(dir, 'consensus_rules_digest.js'));
    fs.mkdirSync(path.join(dir, 'consensus', 'gates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'consensus', 'gate_registry.js'),
        'const real = require(' + JSON.stringify(REGISTRY_SRC) + ');\n'
        + 'const missing = ' + JSON.stringify(missingKey || null) + ';\n'
        + 'module.exports = Object.assign({}, real, { get: (k) => {\n'
        + '    if (k === missing) throw new real.RegistryMissError(k);\n'
        + '    return real.get(k);\n'
        + '} });\n');
    const byModule = new Map();
    for (const [mod, names] of crd.SHARED_GATES) {
        if (!byModule.has(mod)) byModule.set(mod, []);
        byModule.get(mod).push(...names);
    }
    for (const [mod, names] of byModule) {
        const realPath = path.resolve(__dirname, '../../../src', carrierPath(mod));
        const real = fs.existsSync(realPath) ? require(realPath) : {};
        const body = names.map(n => 'exports.' + n + ' = '
            + (typeof real[n] === 'function' ? 'function () {};' : '{ regtest: 0 };')).join('\n');
        fs.writeFileSync(path.join(dir, carrierPath(mod)), body + '\n');
    }
    mutate(dir);
    return require(path.join(dir, 'consensus_rules_digest.js'));
}

describe('consensus_rules_digest: a missing row or a broken carrier is never an absent gate', function () {
    it('digests the whole scratch tree to the shipped digest, so the cases below start green', function () {
        assert.strictEqual(scratchTree(() => {}).computeConsensusRulesDigest().digest,
            crd.computeConsensusRulesDigest().digest);
    });

    it('THROWS naming the key when a registry row is missing, instead of digesting it as absent', function () {
        const victim = 'cross_chain_royalty_activation.CROSS_CHAIN_ROYALTY_ACTIVATION';
        const mod = scratchTree(() => {}, victim);
        assert.throws(() => mod.computeConsensusRulesDigest(), (e) => e.message.includes(victim));
        // The signed GATES field reads the same loader, so a missing row must take it
        // down too rather than publish a silently shortened gate list.
        assert.throws(() => mod.knownGateKeys(), (e) => e.message.includes(victim));
        assert.throws(() => mod.activeGatesAt(0, 'regtest'), (e) => e.message.includes(victim));
    });

    it('THROWS naming the key when the carrier of a function-valued gate is gone', function () {
        const mod = scratchTree(dir => fs.unlinkSync(path.join(dir, carrierPath('mirror_admission_activation'))));
        assert.throws(() => mod.computeConsensusRulesDigest(),
            (e) => e.message.includes('mirror_admission_activation.encodeAdmitBlocks'));
    });

    it('REFUSES when a carrier is present and fails to load, naming it and the cause', function () {
        const victim = 'mirror_admission_activation';
        const mod = scratchTree(dir => fs.writeFileSync(path.join(dir, carrierPath(victim)),
            "require('a-dependency-that-is-not-installed');\n"));
        assert.throws(() => mod.computeConsensusRulesDigest(), (e) => {
            assert.ok(e instanceof Error);
            assert.ok(e.message.includes(victim), 'must name the carrier: ' + e.message);
            assert.ok(e.message.includes('a-dependency-that-is-not-installed'),
                'must carry the underlying cause: ' + e.message);
            return true;
        });
        // The signed wire field and the active set read the same loader, so a broken
        // carrier must take those down too rather than publish a shortened gate list.
        assert.throws(() => mod.knownGateKeys(), /mirror_admission_activation/);
        assert.throws(() => mod.activeGatesAt(0, 'regtest'), /mirror_admission_activation/);
    });
});

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
        // Refuses an absent hub and a lane symlink into a live main checkout alike.
        const hubCheckout = siblingCheckout(__dirname, HUB_COPY);
        if (!hubCheckout.usable) return skipOrFail(this, hubCheckout, 'the xchain-hub consensus_rules_digest twin');
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

// A carrier this build LACKS and a carrier that is here and will not load are two
// different facts, and only the first of them has a digest. The distinction is not
// cosmetic: src/stake_weighted_quorum.js requires mathjs, so a checkout without
// node_modules reports 87637dfa rather than 26ba9cce unless the second case refuses, and
// two revisions measured that way agree with each other while agreeing with no real
// build. The digest is the evidence a restructure is judged on, so a measurement it
// cannot take must refuse rather than round down.
//
// Driven against a COPY of the real module in a scratch directory, with one generated
// stub per SHARED_GATES carrier, because __dirname is what the loader resolves against:
// the cases have to be able to delete and break carriers, which no real checkout may do.
describe('consensus_rules_digest: a broken carrier is not an absent one', function () {

    const os = require('os');
    const MODULE_SRC = path.resolve(__dirname, '../../../src/consensus_rules_digest.js');

    // A standalone tree: the module under test plus a stub for every carrier it names,
    // each exporting the names that carrier owns. `mutate` then removes or breaks one.
    function scratchTree(mutate) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-carrier-'));
        fs.copyFileSync(MODULE_SRC, path.join(dir, 'consensus_rules_digest.js'));
        const byModule = new Map();
        for (const [mod, names] of crd.SHARED_GATES) {
            if (!byModule.has(mod)) byModule.set(mod, []);
            byModule.get(mod).push(...names);
        }
        for (const [mod, names] of byModule) {
            const body = names.map(n => 'exports.' + n + ' = { regtest: 0 };').join('\n');
            fs.writeFileSync(path.join(dir, mod + '.js'), body + '\n');
        }
        mutate(dir);
        return require(path.join(dir, 'consensus_rules_digest.js'));
    }

    it('digests an absent carrier FILE as the absent sentinel and does not throw', function () {
        const victim = 'cross_chain_royalty_activation';
        const mod = scratchTree(dir => fs.unlinkSync(path.join(dir, victim + '.js')));
        const { gates } = mod.computeConsensusRulesDigest();
        assert.strictEqual(gates[victim + '.CROSS_CHAIN_ROYALTY_ACTIVATION'], crd.ABSENT);
        // Absent is a real protocol state, so it must still produce a digest, and one
        // that differs from the same tree with the carrier present.
        const whole = scratchTree(() => {});
        assert.notStrictEqual(mod.computeConsensusRulesDigest().digest,
            whole.computeConsensusRulesDigest().digest);
    });

    it('REFUSES when a carrier is present and fails to load, naming it and the cause', function () {
        const victim = 'stake_weighted_quorum';
        const mod = scratchTree(dir => fs.writeFileSync(path.join(dir, victim + '.js'),
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
        assert.throws(() => mod.knownGateKeys(), /stake_weighted_quorum/);
        assert.throws(() => mod.activeGatesAt(0, 'regtest'), /stake_weighted_quorum/);
    });
});

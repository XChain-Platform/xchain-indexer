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
 * test/unit/consensusRulesDigest.test.js
 *
 * The indexer half of the cross-repo consensus-rules digest. The alarm logic
 * lives on the hub (it is the side that gossips), so this file guards the two
 * things the indexer owns: that its copy resolves every shared gate, and that
 * the digest it publishes on /health is the one a hub would compare against.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const crd    = require('../../src/consensus_rules_digest.js');

const HUB_COPY = path.resolve(__dirname, '../../../xchain-hub/src/consensus_rules_digest.js');

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
        if (!fs.existsSync(HUB_COPY)) {
            if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                assert.fail('xchain-hub sibling checkout missing: ' + HUB_COPY);
            this.skip();
            return;
        }
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
        const src = fs.readFileSync(path.resolve(__dirname, '../../src/health.js'), 'utf8');
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

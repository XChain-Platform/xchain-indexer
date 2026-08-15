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
// ---------------------------------------------------------------------------
// Responsible-set canonical-vector conformance (indexer copy).
//
// The attestation responsible-set rule is implemented independently in
// xchain-hub (AttestationRound._computeResponsibleSet,
// AttestationPublisher._computeResponsible) and here
// (actions/attest._computeResponsibleSet, mirrored by rollback._responsibleSet).
// They MUST produce identical ordered output or attestation quorum evaluation
// forks: the hub signs with S_hub, this indexer filters verified signatures
// against S_idx, and any divergence silently expires every affected request.
//
// xchain-hub has run these vectors against its copy since the source-dedupe
// landed; its test comment claimed the indexer "ships its own mirror guard over
// the SAME vector file", but no such guard existed, so the two copies were only
// ever compared by hand. This is that mirror. It runs the SAME
// xchain-documentation/protocol/test-vectors/responsible_set.json the hub runs.
//
// Sibling policy matches ConsensusPrimitiveConformance: a missing
// xchain-documentation checkout skips (standalone clones), and hard-fails under
// XCHAIN_REQUIRE_SIBLINGS=1 so bin/ci-all.sh cannot pass this green-by-skip.
// ---------------------------------------------------------------------------

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon  = require('sinon');
const path   = require('path');

const { createMockIndexer } = require('../../fixtures/mocks');
const Attest = require('../../../src/actions/attest.js');

const DOCS_DIR = process.env.XCHAIN_DOCS_DIR
    || path.join(__dirname, '..', '..', '..', '..', 'xchain-documentation');
const VEC_PATH = path.join(DOCS_DIR, 'protocol', 'test-vectors', 'responsible_set.json');

let vec = null, vecErr = null;
try { vec = require(VEC_PATH); } catch (e) { vecErr = e; }

// A block far below the mainnet STAKE_WEIGHTED_QUORUM anchor (961000), so the
// weighted/unweighted branch is selected by NETWORK alone: regtest arms the gate at
// genesis, mainnet does not reach it at this height. That keeps each vector's
// `weighted` flag the only thing choosing the branch.
const BLOCK = 100;

describe('ATTEST responsible-set canonical-vector conformance @regression @tier1', function () {

    before(function () {
        if (vec) return;
        if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
            throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the responsible-set canonical vectors are unloadable at '
                + VEC_PATH + ' (' + (vecErr && vecErr.message) + ')');
        this.skip();
    });

    afterEach(() => sinon.restore());

    // Build a handler whose ONLY inputs are the vector's: the capability lookups return
    // the vector's validators verbatim, and the provider registry returns the vector's
    // floor for whatever provider id is asked about.
    function handlerFor(c) {
        const ix = createMockIndexer();
        ix.config.COIN    = 'BTC';
        ix.config.NETWORK = c.weighted ? 'regtest' : 'mainnet';
        const db = ix.indexerDb;
        db.getStakeWeightsByCapability = sinon.stub().resolves(c.validators);
        db.getValidatorsByCapability   = sinon.stub().resolves(c.validators);
        const handler = new Attest({
            config: ix.config, util: ix.util, mapper: ix.mapper,
            decoderDb: ix.decoderDb, indexerDb: db,
            protocolChanges: { isDefined: sinon.stub().returns(true), isEnabled: sinon.stub().resolves(true) }
        });
        handler.providerRegistry = {
            getMinStake: () => (c.minStake === undefined ? null : c.minStake)
        };
        return handler;
    }

    (vec ? vec.computeResponsibleSet : []).forEach(function (c) {
        it(c.name, async function () {
            const got = await handlerFor(c)._computeResponsibleSet(c.requestId, c.redundancy, BLOCK, 'http_get');
            assert.deepStrictEqual(got, c.expected);
        });
    });

    // The reorg recompute is a FOURTH copy of the same rule and is not reachable
    // through _computeResponsibleSet, so run the vectors through it too rather than
    // trusting the two to have been edited together.
    describe('rollback._responsibleSet applies the identical rule', function () {
        const Rollback = require('../../../src/rollback.js');

        (vec ? vec.computeResponsibleSet : []).forEach(function (c) {
            it(c.name, function () {
                const ix = createMockIndexer();
                ix.config.COIN    = 'BTC';
                ix.config.NETWORK = c.weighted ? 'regtest' : 'mainnet';
                ix.protocolChanges = {
                    isDefined: sinon.stub().returns(true),
                    isEnabled: sinon.stub().resolves(true),
                };
                const rb  = new Rollback(ix);
                const got = rb._responsibleSet(c.requestId, c.validators, c.redundancy, c.weighted,
                                               c.minStake === undefined ? null : c.minStake);
                assert.deepStrictEqual(got, c.expected);
            });
        });
    });
});

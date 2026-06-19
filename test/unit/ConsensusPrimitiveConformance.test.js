'use strict';

// Cross-service conformance guard (item 4535). The stake-weighted quorum
// predicate and the equivocation-header builder are hand-copied across five
// services in three bignum dialects; a divergence in their logic forks the
// chain. These vectors are the single source of truth (xchain-documentation/
// protocol/test-vectors); every repo runs them against its own local copy so
// behavioral drift is machine-detectable. When the sibling documentation repo
// is not checked out, skip rather than fail (cross-repo guard convention).

const assert = require('assert');

// Loads BTC/regtest config into the env so new Utility() can resolve its coin
// config (same fixture the quorum + db unit tests use).
require('../fixtures/config').getTestConfig();
const Utility = require('../../src/utility');

const swq   = require('../../src/stake_weighted_quorum.js');
const equiv = require('../../src/equivocation_header.js');

let quorumVec = null, equivVec = null;
try {
    quorumVec = require('../../../xchain-documentation/protocol/test-vectors/stake_weighted_quorum.json');
    equivVec  = require('../../../xchain-documentation/protocol/test-vectors/equivocation_header.json');
} catch(e){ /* sibling xchain-documentation absent */ }

// Per-repo adapter: the indexer copy injects its bignum util:
// meetsStakeThreshold(util, validators, signerPubkeys). It does not export totalStake.
const util = new Utility();
function meets(c){ return swq.meetsStakeThreshold(util, c.validators, c.signers); }

describe('consensus-primitive conformance: canonical vectors @regression', function(){
    before(function(){ if(!quorumVec || !equivVec) this.skip(); });

    describe('stake_weighted_quorum.meetsStakeThreshold', function(){
        (quorumVec ? quorumVec.meetsStakeThreshold : []).forEach(function(c){
            it(c.name, function(){ assert.strictEqual(meets(c), c.expected); });
        });
    });

    describe('equivocation_header builder', function(){
        it('ENGINE_TAGS matches the canonical map', function(){
            assert.deepStrictEqual(equiv.ENGINE_TAGS, equivVec.engineTags);
        });
        (equivVec ? equivVec.equivKey : []).forEach(function(c){
            it('equivKey: ' + c.name, function(){
                assert.strictEqual(equiv.equivKey(c.engineTag, c.roundId, c.view), c.expected);
            });
        });
        (equivVec ? equivVec.equivPrefix : []).forEach(function(c){
            it('equivPrefix: ' + c.name, function(){
                assert.strictEqual(equiv.equivPrefix(c.key), c.expected);
            });
        });
        (equivVec ? equivVec.buildEquivCanonical : []).forEach(function(c){
            it('buildEquivCanonical: ' + c.name, function(){
                assert.strictEqual(equiv.buildEquivCanonical(c.engineTag, c.roundId, c.view, c.content), c.expected);
            });
        });
    });
});

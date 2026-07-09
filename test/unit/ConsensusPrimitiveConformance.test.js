'use strict';

// Cross-service conformance guard (item 4535). The stake-weighted quorum
// predicate and the equivocation-header builder are CONSENSUS-CRITICAL and
// vendored byte-identically into five services (xchain-hub, xchain-indexer,
// xchain-explorer, xchain-sdk, xchain-sync); a divergence in their logic forks
// the chain. The canonical source of record lives in xchain-documentation
// (protocol/reference-impl + protocol/test-vectors). This guard runs in every
// repo and asserts BOTH:
//   1. BEHAVIOR  - the local copy matches the canonical vectors.
//   2. IDENTITY  - the local copy is byte-identical to the canonical source.
// (1) catches a logic change that happens to pass the local unit suite; (2)
// catches ANY edit to one copy that was not propagated to the others. When the
// sibling xchain-documentation repo is not checked out (standalone deploy), skip
// rather than fail, matching the existing cross-repo guard convention.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const swq   = require('../../src/stake_weighted_quorum.js');
const equiv = require('../../src/equivocation_header.js');

const LOCAL_DIR = path.join(__dirname, '..', '..', 'src');
// Resolve the canonical xchain-documentation repo. Prefer an explicit path: GitHub CI
// sets XCHAIN_DOCS_DIR to wherever it checked the sibling out, because actions/checkout
// cannot write a path above the job workspace (the dev/bin/ci-all.sh sibling layout is
// one level above each repo). Fall back to that sibling layout for local + dev runs.
// When neither resolves (standalone deploy), the guards below skip rather than fail.
const DOCS_DIR  = process.env.XCHAIN_DOCS_DIR || path.join(__dirname, '..', '..', '..', 'xchain-documentation');
const CANON_DIR = path.join(DOCS_DIR, 'protocol', 'reference-impl');
const VEC_DIR   = path.join(DOCS_DIR, 'protocol', 'test-vectors');

let quorumVec = null, equivVec = null;
try {
    quorumVec = require(path.join(VEC_DIR, 'stake_weighted_quorum.json'));
    equivVec  = require(path.join(VEC_DIR, 'equivocation_header.json'));
} catch(e){ /* sibling xchain-documentation absent */ }

const CANON_PRESENT = fs.existsSync(CANON_DIR);

// Every copy now shares ONE signature: meetsStakeThreshold(validators, signers),
// and every copy exports totalStake(). No per-repo adapter remains.
// A vector may carry `truncated: true` to exercise the fail-closed-on-truncation
// guard; JSON can't attach the `truncated` property to an array literal, so apply it
// onto a copy of the validators array here (the real set-building query sets it the
// same way on its returned array).
function vecValidators(c){
    if(c && c.truncated){ let v = (c.validators || []).slice(); v.truncated = true; return v; }
    return c.validators;
}
function meets(c){ return swq.meetsStakeThreshold(vecValidators(c), c.signers); }

describe('consensus-primitive conformance: canonical vectors @regression', function(){
    before(function(){ if(!quorumVec || !equivVec) this.skip(); });

    describe('stake_weighted_quorum.meetsStakeThreshold', function(){
        (quorumVec ? quorumVec.meetsStakeThreshold : []).forEach(function(c){
            it(c.name, function(){ assert.strictEqual(meets(c), c.expected); });
        });
    });

    describe('stake_weighted_quorum.totalStake', function(){
        (quorumVec ? quorumVec.totalStake : []).forEach(function(c){
            it(c.name, function(){
                if(c.throws) assert.throws(() => swq.totalStake(vecValidators(c)));
                else assert.strictEqual(String(swq.totalStake(vecValidators(c))), c.expected);
            });
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

describe('consensus-primitive conformance: byte-identity to canonical source @regression', function(){
    before(function(){ if(!CANON_PRESENT) this.skip(); });

    ['stake_weighted_quorum.js', 'equivocation_header.js'].forEach(function(f){
        it(f + ' is byte-identical to xchain-documentation/protocol/reference-impl', function(){
            const local = fs.readFileSync(path.join(LOCAL_DIR, f), 'utf8');
            const canon = fs.readFileSync(path.join(CANON_DIR, f), 'utf8');
            assert.strictEqual(local, canon,
                'this repo\'s ' + f + ' has drifted from the canonical source; ' +
                'edit xchain-documentation/protocol/reference-impl/' + f + ' and re-vendor all five copies.');
        });
    });
});

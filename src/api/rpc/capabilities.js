/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Indexer - JSON-RPC capability family: the per-capability validator sets the hub locks quorum on.
 *
 * Each group factory below closes over the context object src/api.js builds
 * (apiContext) and returns its methods verbatim; src/api/rpc/index.js merges
 * every family into the one controller the JSON-RPC router dispatches on.
 *
 ********************************************************************/

const capabilityValidators = require('../capability_validators');
const srb          = require('../../snapshot_reorg_buffer.js');      // CANONICAL_REORG_BUFFER, to reconstruct the raw request height
const gatesFilter  = require('../../actions/attest/rollcall_gates_filter.js');      // rules-aware attestation capability filter
const { getLogger } = require('../../observability/index.js');

function buildCapabilitiesRpc(ctx){
    return Object.assign({}, capabilityValidatorsRpc(ctx), fullNodeVerifiersRpc(ctx), stakeWeightsByCapabilityRpc(ctx));
}

// Return the validator-set snapshot for a capability at a block boundary.
// Used by xchain-hub's CapabilitySnapshot to lock PBFT quorum N for a
// consensus round. Deterministic: every hub at the same block sees
// the same set, so all hubs compute the same quorum.
// Body: { capability, block_index, min_stake? }
// min_stake (optional) lets a caller (the hub) supply its own authoritative
// threshold so the validator set doesn't depend on this indexer's local
// config. Omitted → indexer falls back to its local config (back-compat).
//
// RULES-AWARE FILTER, `attestation` only. The
// indexer, not the hub, owns this: the hub's CapabilitySnapshot carries
// no twin, and adding a height parameter to this RPC would let a caller
// choose the height its own set is judged at, which is precisely the
// attack attest_response_verify.js:32-41 names.
//
// WHY block_index + CANONICAL_REORG_BUFFER. `block_index` here is
// ALREADY the buried block: CapabilitySnapshot.getSnapshot subtracts the
// buffer before it calls (validators/capability_snapshot.js:238). The filter buries
// its own argument, exactly as _computeResponsibleSet does, so it must
// be handed the raw request height whose burial is this block_index.
// Two edges follow. buriedSnapshotBlock clamps at 0, so for the first
// CANONICAL_REORG_BUFFER blocks of a chain several raw heights bury to
// the same block and this reconstruction is off by the clamp; those
// blocks predate any rolled epoch, so the filter reads no row and drops
// nobody there either way. And on a network where snapshot burial is not
// armed the filter's burial is the identity, so it would judge at
// block_index + buffer; that is inert too, because ROLLCALL_GATES is null
// on every network whose burial is un-armed.
function capabilityValidatorsRpc({ indexer }){
    return {
        async getcapabilityvalidators({capability, block_index, min_stake}){
            let parsed = capabilityValidators.parseCapabilityRequest({capability, block_index});
            if(parsed.error) return parsed;
            let blk = parsed.blk;
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            let configuredError = capabilityValidators.unconfiguredCapabilityError(db, capability);
            if(configuredError) return configuredError;
            try {
                let indexingError = await capabilityValidators.notYetIndexedError(db, blk);
                if(indexingError) return indexingError;
                let validators = await db.getValidatorsByCapability(capability, blk, min_stake);
                // VALIDATOR_QUERY_LIMIT flag rides on the array itself, so read it
                // BEFORE the rules filter below hands back a fresh array.
                let truncated  = validators.truncated === true;
                if(capability === 'attestation'){
                    let gatesStats = {};
                    validators = await gatesFilter.filterByRolledGates({
                        db, validators, requestBlock: blk + srb.CANONICAL_REORG_BUFFER,
                        network: indexer.config['NETWORK'], stats: gatesStats
                    });
                    capabilityValidators.logGatesFilterStats(gatesStats);
                }
                capabilityValidators.logSnapshotThreshold(
                    capability, blk, min_stake, validators.length);
                return {
                    capability:  capability,
                    block_index: blk,
                    count:       validators.length,
                    // Additive: true when the result hit VALIDATOR_QUERY_LIMIT, so a
                    // hub can alarm rather than silently consume a truncated set.
                    truncated:   truncated,
                    validators:  validators
                };
            } catch (err) {
                getLogger().error('getcapabilityvalidators error:', err);
                return { error: 'failed to look up capability validators' };
            }
        },
    };
}

// Verified full-node set at a block (NODEPROOF / verified-validator tier):
// validators with a passed possession proof inside PROOF_WINDOW_BLOCKS of
// `block_index`. The hub unions this with FULLNODE.GENESIS_VERIFIERS to form
// the eligible-verifier set for a challenge round, matching the indexer's
// acceptance rule in actions/nodeproof.js. The live-stake intersection is applied
// HERE, by this RPC, not by the caller: the returned set is already the
// proof-window set intersected with the live full_node capability at
// `block_index`. A caller must NOT re-filter it through a capability snapshot of
// its own. That set is the 2/3+1 quorum denominator, and nodeproof.js sizes the
// chain's acceptance quorum over this same rule, so a second filter (which
// carries its own MIN_STAKE predicate) shrinks the hub's divisor below the one
// the chain will accept.
function fullNodeVerifiersRpc({ indexer }){
    return {
        async getfullnodeverifiers({block_index}){
            if(block_index === undefined || block_index === null)
                return { error: 'block_index is required' };
            let blk = Number(block_index);
            if(!Number.isInteger(blk) || blk < 0)
                return { error: 'block_index must be a non-negative integer' };
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            try {
                // Intersect the proof-window set with the LIVE full_node capability
                // at this block (byte-identical to the eligibility rule in
                // actions/nodeproof.js (eligibleVerifierSet) and the reward split in
                // actions/price.js, so the hub sizes quorum over the same set the
                // chain will accept.
                // Resolve the capability side ONCE (hasCapability is ~5 sequential
                // queries per pubkey); a truncated capability read re-probes per pubkey
                // so the hub's quorum divisor cannot silently shrink.
                let raw = await db.getVerifiedFullNodeSet(blk);
                let capRows = await db.getValidatorsByCapability('full_node', blk);
                let capSet  = (capRows && capRows.truncated === true)
                            ? null
                            : new Set((capRows || []).map(v => String(v.pubkey).toLowerCase()));
                let validators = [];
                for(let v of raw){
                    let pk = String(v.pubkey).toLowerCase();
                    if(capSet ? capSet.has(pk) : await db.hasCapability(v.pubkey, 'full_node', blk))
                        validators.push(v);
                }
                return {
                    block_index: blk,
                    count:       validators.length,
                    // Additive: true when the result hit VALIDATOR_QUERY_LIMIT, so a
                    // hub can alarm rather than silently consume a truncated set.
                    truncated:   raw.truncated === true,
                    validators:  validators
                };
            } catch (err) {
                getLogger().error('getfullnodeverifiers error:', err);
                return { error: 'failed to look up full-node verifiers' };
            }
        },
    };
}

// Source-keyed validator weights for stake-weighted quorum (STAKE_WEIGHTED_QUORUM).
// Like getcapabilityvalidators but returns each effective signing key's `source`
// (staking address) + the source's aggregate `weight`. The hub mirrors these into
// capability_snapshots so every validator dedupes voting weight by source; one
// stake counts once no matter how many keys it has delegated (DELEGATE.md).
function stakeWeightsByCapabilityRpc({ indexer }){
    return {
        async getstakeweightsbycapability({capability, block_index, min_stake}){
            if(!capability || typeof capability !== 'string')
                return { error: 'capability is required' };
            if(block_index === undefined || block_index === null)
                return { error: 'block_index is required' };
            let blk = Number(block_index);
            if(!Number.isInteger(blk) || blk < 0)
                return { error: 'block_index must be a non-negative integer' };
            if(!indexer.indexerDb)
                return { error: 'indexer database not ready' };
            // Federation READ isolation: committed-only, off the block tx.
            let db = indexer.indexerDb.apiView();
            if(!db.isCapabilityConfigured(capability))
                return { error: 'capability not configured: ' + capability };
            try {
                let latestBlock = await db.getLatestBlockIndex();
                if(blk > latestBlock)
                    return { error: 'block_index ' + blk + ' not yet indexed (latest: ' + latestBlock + ')' };
                let validators = await db.getStakeWeightsByCapability(capability, blk, min_stake);
                let sources = new Set(validators.map(v => v.source));
                let thresholdSource = (min_stake !== undefined && min_stake !== null)
                    ? String(min_stake) + ' (caller-supplied)'
                    : 'local-config';
                getLogger().info('getstakeweightsbycapability: capability=' + capability +
                    ' block=' + blk + ' min_stake=' + thresholdSource +
                    ' keys=' + validators.length + ' sources=' + sources.size);
                return {
                    capability:  capability,
                    block_index: blk,
                    count:       validators.length,
                    source_count: sources.size,
                    // Additive: true when the result hit VALIDATOR_QUERY_LIMIT, so a
                    // hub can alarm rather than silently consume a truncated set.
                    truncated:   validators.truncated === true,
                    validators:  validators
                };
            } catch (err) {
                getLogger().error('getstakeweightsbycapability error:', err);
                return { error: 'failed to look up stake weights' };
            }
        },
    };
}

module.exports = { buildCapabilitiesRpc };

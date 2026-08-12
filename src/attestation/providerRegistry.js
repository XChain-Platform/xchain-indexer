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
 * XChain Indexer - Provider Registry
 *
 * The consensus-authoritative allow-list of attestation providers the indexer
 * uses to validate ATTEST v0 (request) actions: provider_id known, redundancy
 * in the allowed list, payload within max, deadline within window. Structural
 * validation only; the hub side does the actual fetch and consensus.
 *
 * Effective set = built-in DEFAULTS (`http_get`, `llm`) overlaid with an optional
 * governance/operator config block (`config.ATTESTATION.PROVIDERS`), the same
 * pattern used for STAKING.CAPABILITIES[*].MIN_STAKE: DEFAULTS are the shipped
 * floor, and any config-added/tuned provider takes effect only through a
 * coordinated rollout every node applies in lockstep, so behavior stays
 * consensus-safe with no config block present.
 *
 * A fully dynamic on-chain governance load (reading provider configs whose
 * activation is block-anchored, like the llm approved_models ladder, spec §16
 * Phase 6) is deferred: it needs a deterministic, block-anchored config read so
 * a mid-history provider change replays identically. Until that lands, this
 * DEFAULTS-plus-static-config overlay is the consensus-safe seam.
 *
 ********************************************************************/

const PROVIDERS = {
    http_get: {
        provider_id:            'http_get',
        version:                1,
        consensus_strategy:     'byte_equality',
        max_request_bytes:      2048,
        max_response_bytes:     32768,
        allowed_redundancy:     [1, 3, 5],
        deadline_window_blocks: 100
    },
    // Hub performs the actual LLM API call and consensus judgment; this entry
    // only sets the structural bounds the indexer checks.
    llm: {
        provider_id:            'llm',
        version:                1,
        consensus_strategy:     'judge_model',
        max_request_bytes:      8192,
        max_response_bytes:     16384,
        allowed_redundancy:     [1, 3, 5],
        deadline_window_blocks: 20
    }
};

// Build the effective provider map: built-in DEFAULTS overlaid with an optional
// governance/operator config block. Each config entry fully REPLACES the matching
// default (rather than field-merging) so a config-registered provider is a complete,
// self-describing definition and a partial override can never leave a stale default
// field silently in force. Non-object config values are ignored (fail toward the
// safe DEFAULTS). Absent/empty config -> a shallow copy of DEFAULTS, so mutating one
// registry instance can never bleed into another or into the module-level DEFAULTS.
function buildEffectiveProviders(config) {
    let effective = {};
    for (let id of Object.keys(PROVIDERS)) effective[id] = PROVIDERS[id];
    let overlay = config && config.ATTESTATION && config.ATTESTATION.PROVIDERS;
    if (overlay && typeof overlay === 'object') {
        for (let id of Object.keys(overlay)) {
            let def = overlay[id];
            if (def && typeof def === 'object') effective[id] = def;
        }
    }
    return effective;
}

class ProviderRegistry {

    // config (optional): the coin config object; ATTESTATION.PROVIDERS overlays the
    // built-in DEFAULTS. Called with no args (module-level deadline-window snapshots,
    // tests) it resolves to DEFAULTS unchanged.
    constructor(config) {
        this.providers = buildEffectiveProviders(config);
    }

    isKnown(providerId) {
        return Object.prototype.hasOwnProperty.call(this.providers, providerId);
    }

    getProvider(providerId) {
        return this.providers[providerId] || null;
    }

    isRedundancyAllowed(providerId, redundancy) {
        let p = this.providers[providerId];
        if (!p) return false;
        return Array.isArray(p.allowed_redundancy) && p.allowed_redundancy.indexOf(Number(redundancy)) !== -1;
    }

    isPayloadSizeAllowed(providerId, payloadByteLength) {
        let p = this.providers[providerId];
        if (!p) return false;
        return Number(payloadByteLength) <= Number(p.max_request_bytes);
    }

    // Caller passes (currentBlock, deadlineBlock); checks 0 < (deadlineBlock - currentBlock) <= window.
    isDeadlineAllowed(providerId, currentBlock, deadlineBlock) {
        let p = this.providers[providerId];
        if (!p) return false;
        let delta = Number(deadlineBlock) - Number(currentBlock);
        return delta > 0 && delta <= Number(p.deadline_window_blocks);
    }

    listProviderIds() {
        return Object.keys(this.providers);
    }

    // Map of provider_id -> deadline_window_blocks, for injection into the VM
    // gateway so attestation.request() rejects an over-limit deadlineBlocks at
    // contract call time instead of letting it land on-chain and then fail the
    // structural DEADLINE check here (which strands the callback silently).
    getDeadlineWindows() {
        let windows = {};
        for (let id of Object.keys(this.providers))
            windows[id] = Number(this.providers[id].deadline_window_blocks);
        return windows;
    }
}

module.exports = ProviderRegistry;
module.exports.PROVIDERS = PROVIDERS;

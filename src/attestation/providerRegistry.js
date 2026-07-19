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
 * uses to validate ATTEST v0 (request) actions (provider_id known, redundancy in
 * allowed list, payload within max, deadline within window). Structural validation
 * only: the hub side does the actual fetch + consensus.
 *
 * Effective set = built-in DEFAULTS (`http_get`, `llm`) OVERLAID with an optional
 * governance/operator config block (`config.ATTESTATION.PROVIDERS`). This mirrors
 * how STAKING.CAPABILITIES[*].MIN_STAKE is a versioned, consensus-shipped config
 * input rather than a hard-coded literal: the DEFAULTS are the shipped floor, and a
 * provider added/tuned via config takes effect only through the same coordinated
 * config rollout every node applies in lockstep. When no config block is present
 * (the shipping state today) the effective set is byte-identical to DEFAULTS, so
 * this stays a no-op consensus-wise until governance registers a provider.
 *
 * Note on the fuller design (spec §16, Phase 6): a fully DYNAMIC on-chain
 * governance-load (reading ATTESTATION_PROVIDER:{id} configs whose activation is
 * block-anchored, like the llm approved_models ladder) is deferred. It needs a
 * deterministic block-anchored provider-config read so a mid-history provider
 * change replays identically; until that lands, the DEFAULTS-plus-static-config
 * overlay here is the consensus-safe seam.
 *
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md
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
    // Spec: claude/reports/specs/2026-05-24_llm-attestation-provider.md §3.
    // The indexer's job here is structural validation only: provider_id
    // is in the registry, the payload fits, redundancy is allowed, deadline
    // is within window. The hub side does the actual LLM API call + consensus.
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

    // Whether a provider id is known and currently enabled
    isKnown(providerId) {
        return Object.prototype.hasOwnProperty.call(this.providers, providerId);
    }

    // Get the full provider definition, or null
    getProvider(providerId) {
        return this.providers[providerId] || null;
    }

    // Check whether a redundancy value is allowed for this provider
    isRedundancyAllowed(providerId, redundancy) {
        let p = this.providers[providerId];
        if (!p) return false;
        return Array.isArray(p.allowed_redundancy) && p.allowed_redundancy.indexOf(Number(redundancy)) !== -1;
    }

    // Validate a payload size against the provider's max_request_bytes
    isPayloadSizeAllowed(providerId, payloadByteLength) {
        let p = this.providers[providerId];
        if (!p) return false;
        return Number(payloadByteLength) <= Number(p.max_request_bytes);
    }

    // Validate a deadline against the provider's deadline_window_blocks
    // Caller passes (currentBlock, deadlineBlock); we check 0 < (deadlineBlock - currentBlock) <= window
    isDeadlineAllowed(providerId, currentBlock, deadlineBlock) {
        let p = this.providers[providerId];
        if (!p) return false;
        let delta = Number(deadlineBlock) - Number(currentBlock);
        return delta > 0 && delta <= Number(p.deadline_window_blocks);
    }

    // List all provider ids known to the registry
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

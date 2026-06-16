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
 * XChain Indexer - Provider Registry (Phase 1 stub)
 *
 * Hard-coded allow-list of attestation providers known to the indexer.
 * The indexer uses this registry to validate ATTEST v0 (request) actions
 * (provider_id known, redundancy in allowed list, payload within max).
 *
 * Phase 1 ships with `http_get` only. Phase 2 swaps this stub for a
 * hub-backed registry that pulls governance-approved provider definitions
 * from on-chain ATTESTATION_PROVIDER:{id} configs.
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
    // The indexer's job here is structural validation only — provider_id
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

class ProviderRegistry {

    constructor() {
        // Phase 1: no external state. Registry is the static PROVIDERS map.
    }

    // Whether a provider id is known and currently enabled
    isKnown(providerId) {
        return Object.prototype.hasOwnProperty.call(PROVIDERS, providerId);
    }

    // Get the full provider definition, or null
    getProvider(providerId) {
        return PROVIDERS[providerId] || null;
    }

    // Check whether a redundancy value is allowed for this provider
    isRedundancyAllowed(providerId, redundancy) {
        let p = PROVIDERS[providerId];
        if (!p) return false;
        return Array.isArray(p.allowed_redundancy) && p.allowed_redundancy.indexOf(Number(redundancy)) !== -1;
    }

    // Validate a payload size against the provider's max_request_bytes
    isPayloadSizeAllowed(providerId, payloadByteLength) {
        let p = PROVIDERS[providerId];
        if (!p) return false;
        return Number(payloadByteLength) <= Number(p.max_request_bytes);
    }

    // Validate a deadline against the provider's deadline_window_blocks
    // Caller passes (currentBlock, deadlineBlock); we check 0 < (deadlineBlock - currentBlock) <= window
    isDeadlineAllowed(providerId, currentBlock, deadlineBlock) {
        let p = PROVIDERS[providerId];
        if (!p) return false;
        let delta = Number(deadlineBlock) - Number(currentBlock);
        return delta > 0 && delta <= Number(p.deadline_window_blocks);
    }

    // List all provider ids known to the registry
    listProviderIds() {
        return Object.keys(PROVIDERS);
    }

    // Map of provider_id -> deadline_window_blocks, for injection into the VM
    // gateway so attestation.request() rejects an over-limit deadlineBlocks at
    // contract call time instead of letting it land on-chain and then fail the
    // structural DEADLINE check here (which strands the callback silently).
    getDeadlineWindows() {
        let windows = {};
        for (let id of Object.keys(PROVIDERS))
            windows[id] = Number(PROVIDERS[id].deadline_window_blocks);
        return windows;
    }
}

module.exports = ProviderRegistry;
module.exports.PROVIDERS = PROVIDERS;

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const vectors = require('../../../../../fixtures/anchor_canonical_vectors.json');

function byPubkey(a, b) {
    return a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0;
}

function addPairs(params, pairs) {
    const ordered = pairs.slice().sort(byPubkey);
    params.push(String(ordered.length));
    for (const pair of ordered) params.push(String(pair.pubkey), String(pair.sig));
}

function addSection(params, section) {
    params.push(String(section.chain), String(section.block_index), String(section.block_hash),
        String(section.ledger_hash), String(section.actions_hash), String(section.contract_hash),
        String(section.checkpoint_seq), String(section.snapshot_block), String(section.state_root),
        String(section.state_root_version), String(section.block_merkle_root),
        String(section.block_merkle_version));
    addPairs(params, section.validator_signatures);
}

function addArchive(params, bundle, opts) {
    const archiveCount = opts.archiveCount !== undefined
        ? opts.archiveCount
        : opts.archive === false ? 0 : bundle.archive_count;
    params.push(String(archiveCount));
    if (opts.archive === false) return;
    const wrapperIndex = opts.wrapperSectionIndex !== undefined
        ? opts.wrapperSectionIndex
        : bundle.wrapper_section_index;
    params.push(String(wrapperIndex), String(bundle.match_batch_seq), String(bundle.match_count),
        String(bundle.batch_crc32), String(bundle.total_chunks), String(bundle.archive_b64));
}

function v3Params(opts = {}) {
    const bundle = vectors.fixture.bundle_v3;
    const sections = (opts.sections === undefined ? bundle.sections : opts.sections)
        .slice().sort((a, b) => a.chain < b.chain ? -1 : a.chain > b.chain ? 1 : 0);
    const params = ['3', String(bundle.network), String(bundle.snapshot_block), String(sections.length)];
    for (const section of sections) addSection(params, section);
    addArchive(params, bundle, opts);
    params.push(String(bundle.publisher));
    addPairs(params, bundle.attest_sigs);
    return params;
}

module.exports = { vectors, v3Params };

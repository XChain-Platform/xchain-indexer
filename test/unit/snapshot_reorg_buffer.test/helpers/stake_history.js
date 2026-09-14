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
// The stake history every party of the capability-snapshot reorg burial suite is
// asked about, shared by test/unit/snapshot_reorg_buffer.test.js and the parts
// beside it.

const srb = require('../../../../src/snapshot_reorg_buffer.js');

// ── The stake history every party is asked about ─────────────────────────────
// Declared snapshot height N; the buried height the hub actually resolves at is
// N - CANONICAL_REORG_BUFFER. A is stable outside the window; B DEACTIVATES and
// C ACTIVATES inside it, so the two heights disagree in both directions.
const N       = 1000;
const BURIED  = N - srb.CANONICAL_REORG_BUFFER;   // 994

const PK_A = 'a'.repeat(64);   // active throughout          -> in both sets
const PK_B = 'b'.repeat(64);   // deactivates at 997         -> in the buried set only
const PK_C = 'c'.repeat(64);   // activates   at 998         -> in the raw set only

const STAKES = [
    { pubkey: PK_A, activation: 100, deactivation: null },
    { pubkey: PK_B, activation: 100, deactivation: 997  },
    { pubkey: PK_C, activation: 998, deactivation: null },
];

// The qualifying set at an arbitrary height, the rule db.js applies:
// activation_block <= h AND (deactivation_block IS NULL OR deactivation_block > h).
function setAt(h){
    return STAKES
        .filter(s => s.activation <= Number(h) && (s.deactivation === null || s.deactivation > Number(h)))
        .map(s => s.pubkey);
}

module.exports = { N, BURIED, PK_A, PK_B, PK_C, STAKES, setAt };

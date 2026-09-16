/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * The compiled consensus-version pin, the value isEnabled() ranks every
 * time-table row against. Its own part file so the registry can register it
 * as the row protocol_changes.CONSENSUS_VERSION without requiring the entry.
 *
 ********************************************************************/

'use strict';

// Consensus protocol version, COMPILED IN.
//
// isEnabled() compares this against the version registered on every protocol
// change, so it decides WHICH consensus rules this node applies. Its earlier definition,
// `process.env.npm_package_version || require('../package.json').version`,
// made a consensus input out of npm packaging metadata: a routine
// `npm version` bump moved it, a bare `node src/api.js` resolved it
// differently from `npm run`, and a host whose node_modules/package.json
// disagreed resolved it differently again. Two nodes resolving two values fork
// on the first version-gated action, silently, with no flag-day involved.
//
// Pinning it here decouples packaging from consensus in both directions:
// releasing a new npm version no longer touches consensus, and moving consensus
// is now a deliberate one-line edit reviewed on its own merits. The pin is kept
// equal to the package version by assertConsensusVersionPin() (called at
// indexer boot) and by test/unit/protocol_changes.test.js, so the two cannot
// drift apart unnoticed; that equality is what makes this change a no-op on
// every host today (spec §7 pre-window gate).
// RENUMBERED ONTO THE PLATFORM VERSION STREAM (2026-08-14, first train).
//
// This repo's package version moved from its own stream (2.7.17) to the shared
// platform stream, whose first release is 0.9.0. The pin above must equal the
// package version, so it moved too, and the registry below had to move WITH it:
// every change was registered at 1.0.0 or 2.0.0, and 0.9.0 is BELOW both, so
// leaving the registry alone would have disabled all 89 changes at once and
// made this node compute entirely different state. The gate caught exactly that.
//
// The registry was shifted ORDINALLY, not flattened: 1.0.0 -> 0.1.0 and
// 2.0.0 -> 0.2.0. Flattening both tiers to one number was tried first and the
// suite rejected it, because tests such as "a pre-consensus (v1.x) node treats
// it as not-yet-active" depend on the two tiers being distinguishable. The shift
// preserves that ordering exactly; it only re-expresses it underneath the
// platform stream.
//
// WHY THIS IS NOT A CONSENSUS CHANGE. The version gate disabled nothing before
// (0 of 89 at 2.7.17) and disables nothing after (0 of 89 at 0.9.0), so the
// enabled set is identical; activation is decided by the per-network time/block
// arguments, which were not touched. The registry and this constant live in the
// same file and ship in the same artifact, so a node can never run one without
// the other.
//
// A future change gates normally against the platform stream: register it at the
// platform version it ships in, and nodes below that version treat it as
// not-yet-active exactly as before.

// The registry stays put across the 0.9.0 -> 0.10.0 move: every change registers
// at 0.1.0 or 0.2.0, and isEnabled() ranks components numerically rather than
// lexically, so 0.10.0 outranks both and the enabled set holds at 90 of 90.
// 0.12.0 -> 0.12.1 registers nothing new. The patch restores admission of anchor
// bytes the judge already had to read, so the enabled set is identical and no
// activation argument moved; the pin advances only because it must track the
// package version, which is what keeps a node from applying a rule set it was
// not built for.
// 0.12.1 -> 0.15.0 registers nothing new either, and this was checked rather than
// assumed: every one of the 95 addChange() entries below registers at 0.1.0 or
// 0.2.0, so nothing sits in the gap that a higher pin would newly enable and the
// enabled set is identical on both sides of the bump. The train's consensus work
// (the ATTEST response mirror, ROLLCALL) gates on its OWN per-network activation
// heights, which are unarmed off regtest, not on this ordinal. So the second line
// of the deliberate two-line decision is: the rule set does not move here.
// 0.16.1 -> 0.17.0 registers nothing new, checked the same way: all 96 entries
// below (24 at 0.1.0, 72 at 0.2.0) still sit at those two rungs, so the enabled
// set is identical on both sides of the bump. The two rules this train carries,
// CONTRACT_META_REQUIRED and REST_PATTERN_METER, both register at 0.2.0 and take
// their own per-network instants, not this ordinal.
const CONSENSUS_VERSION = '0.18.0';

module.exports = { CONSENSUS_VERSION };

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
 * The one regtest arming grammar, read for the registry at registration.
 *
 * Five gate rows (ROLLCALL, ROLLCALL gates, the two mirror-admission heights
 * and the anchor-attest barrier) let a regtest venue arm their regtest entry
 * from an environment variable instead of a committed height: that is how one
 * venue carries an armed and an inert indexer and shows them binding the same
 * row at different blocks. Their modules keep their own resolver functions
 * (the exported ones tests drive), but the VALUE a running process applies is
 * the registry row, so the environment is read once here, when the SHARED
 * block is registered, by the same grammar every one of those resolvers uses.
 *
 * UNSET SHIPS INERT. Arming a network commits every BTC indexer on it to a
 * wired DOGE peer, so a venue opts in; a BTC-only venue that cannot answer a
 * roll-call close is left alone.
 *
 ********************************************************************/

'use strict';

/**
 * The regtest arming height named by `raw`, the value of one env variable.
 *
 * Accepted forms, case-insensitive and trimmed:
 *   armed | genesis | on | true | yes  -> armedHeight
 *   a non-negative integer             -> that height, for a venue whose epochs
 *                                         should begin above an indexed prefix
 *   unset | '' | off | inert | false | no | none -> null (INERT)
 * Anything else fails CLOSED to null and says so on stderr as a process
 * warning (the registry depends on no logger), because a typo that silently
 * armed a venue would produce closes nobody meant to drive.
 *
 * @param {string|undefined} raw   the env variable's value
 * @param {number} armedHeight     the height the armed form resolves to
 * @param {string} label           the family named on stderr for a refused value
 * @param {string} envName         the env variable named on stderr
 * @returns {number|null}
 */
function regtestHeight(raw, armedHeight, label, envName) {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).trim().toLowerCase();
    if (s === '' || s === 'off' || s === 'inert' || s === 'false' || s === 'no' || s === 'none') return null;
    if (s === 'armed' || s === 'genesis' || s === 'on' || s === 'true' || s === 'yes') return armedHeight;
    if (/^\d+$/.test(s)) {
        const h = parseInt(s, 10);
        if (Number.isFinite(h) && h >= 0) return h;
    }
    process.emitWarning(label + ': ignoring ' + envName + '=' + JSON.stringify(String(raw)) +
                        '; regtest stays INERT. Expected a non-negative height, "armed", or "off".',
                        'RegtestArmingWarning');
    return null;
}

module.exports = { regtestHeight };

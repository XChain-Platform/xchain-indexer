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
 ********************************************************************/

'use strict';

const TERMINAL_VERDICTS = new Set(['complete', 'mismatch']);

function decideCompletionWrite({ group, verdict, existingCompletion, pieceActionIndex, blockIndex }) {
    if (verdict === null) return null;
    if (group.manifest === null)
        throw new TypeError('a multipart completion verdict requires a manifest');
    if (!TERMINAL_VERDICTS.has(verdict) || existingCompletion !== null) return null;

    const pieceIsAboveCompletion = [group.manifest, ...group.parts]
        .some((piece) => pieceActionIndex < piece.action_index);
    if (pieceIsAboveCompletion)
        throw new RangeError('completion action index must be at or above every multipart piece');

    return {
        action_index: pieceActionIndex,
        manifest_action_index: group.manifest.action_index,
        result: verdict,
        block_index: blockIndex,
    };
}

module.exports = { decideCompletionWrite };

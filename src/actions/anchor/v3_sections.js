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
 ********************************************************************/

'use strict';

const validate = require('./validate.js');

function walkFoldSections(handler, split, data, error){
    const sections = [];
    const seenChains = new Set();
    if(error) return { error, sections };

    for(let i = 0; i < split.sections.length; i++){
        const slice = split.sections[i];
        const section = validate.readSection(slice, 0, i, data.NETWORK);
        const reason = handler.validateSectionShape(section, seenChains);
        if(reason) return { error: 'invalid: SECTION ' + i + ' ' + reason, sections };

        const parsed = validate.parseSectionSigs(slice, 0, i);
        if(parsed.error) return { error: parsed.error, sections };
        section.SIGS = parsed.sigs;
        seenChains.add(section.CHAIN);
        sections.push(section);
    }

    if(sections.length > 0){
        const maximum = sections.reduce((value, section) =>
            Math.max(value, Number(section.SNAPSHOT_BLOCK)), 0);
        if(Number(data.SNAPSHOT_BLOCK) !== maximum)
            error = 'invalid: SNAPSHOT_BLOCK (not the section maximum)';
    }

    return { error, sections };
}

module.exports = { walkFoldSections };

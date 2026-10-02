/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
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

const crypto = require('crypto');

function listMembershipHash(members){
    const canonical = ['MEMBERS', String(members.length), ...members].join('|');
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function listMetaHash(name, description){
    const noName = name === null || name === undefined;
    const noDescription = description === null || description === undefined;
    if(noName && noDescription)
        return '';

    const canonical = ['LISTMETA', name ?? '', description ?? ''].join('|');
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

module.exports = { listMembershipHash, listMetaHash };

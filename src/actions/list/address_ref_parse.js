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

const CANONICAL_CARET_ID = /^[1-9][0-9]*$/;

function addressRefId(item){
    if(typeof item !== 'string' || item[0] !== '^') return null;
    let id = item.slice(1);
    return CANONICAL_CARET_ID.test(id) ? id : null;
}

function isAddressRefItem(item){
    return addressRefId(item) !== null;
}

module.exports = {
    addressRefId,
    isAddressRefItem
};

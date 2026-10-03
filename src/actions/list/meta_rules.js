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

const { isValidMetaText } = require('../deploy/contract_meta/meta_text.js');

function metaFieldVerdict(field, value, maxBytes, isCreate){
    if(value === '')
        return null;
    if(typeof value !== 'string')
        return `invalid: ${field} (format)`;
    if(value.includes('|'))
        return `invalid: ${field} (pipe)`;
    if(value.includes(';'))
        return `invalid: ${field} (semicolon)`;
    if(Buffer.byteLength(value, 'utf8') > maxBytes)
        return `invalid: ${field} (length)`;
    if(!isValidMetaText(value, maxBytes, false) || (isCreate && value === '-'))
        return `invalid: ${field} (format)`;
    return null;
}

function resolveField(currentValue, field){
    if(field === '')
        return currentValue ?? null;
    if(field === '-')
        return null;
    return field;
}

function resolveMeta(current, nameField, descriptionField){
    let name = current && current.name !== undefined ? current.name : null;
    let description = current && current.description !== undefined ? current.description : null;
    return {
        name: resolveField(name, nameField),
        description: resolveField(description, descriptionField),
    };
}

function isNoChange(nameField, descriptionField){
    return nameField === '' && descriptionField === '';
}

module.exports = {
    metaFieldVerdict,
    resolveMeta,
    isNoChange,
};

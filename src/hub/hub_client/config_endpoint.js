// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

function clean(value){
    return typeof value === 'string' ? value.trim() : '';
}

function resolveConfigEndpoint({ configUrl, apiUrl, seedUrls, configApiKey, apiKey } = {}){
    let url = clean(configUrl) || clean(apiUrl);
    let key = clean(configApiKey) || clean(apiKey);
    let enabled = url.length > 0;
    let notice = !enabled && clean(seedUrls)
        ? 'Hub config poll is off because no config or API address is set.'
        : null;

    return { url, apiKey: key, enabled, notice };
}

module.exports = { resolveConfigEndpoint };

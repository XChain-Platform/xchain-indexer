// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

function parseHubList(result){
    if(result === null || typeof result !== 'object' || !Array.isArray(result.hubs)) return [];

    let origins = [];
    let seen = new Set();

    for(let hub of result.hubs){
        if(hub === null || typeof hub !== 'object' || typeof hub.api_url !== 'string') continue;

        let candidate = hub.api_url.trim();
        let shape = candidate.match(/^https?:\/\/([^/?#]*)(.*)$/i);
        if(!shape || shape[1].includes('@') || (shape[2] !== '' && shape[2] !== '/')) continue;

        let parsed;
        try {
            parsed = new URL(candidate);
        } catch (err) {
            continue;
        }

        if((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
           !parsed.host || parsed.username || parsed.password ||
           parsed.pathname !== '/' || parsed.search || parsed.hash) continue;

        if(!seen.has(parsed.origin)){
            seen.add(parsed.origin);
            origins.push(parsed.origin);
        }
    }

    return origins;
}

module.exports = { parseHubList };

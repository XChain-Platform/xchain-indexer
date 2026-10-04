// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const { parseHubList } = require('../../../../src/hub/hub_client/hub_list.js');

describe('parseHubList()', function(){
    it('keeps valid HTTP and HTTPS hubs in first-seen order as origins', function(){
        assert.deepStrictEqual(parseHubList({ hubs: [
            { api_url: 'https://first.example.com:8443', signing_pubkey: 'key-1' },
            { api_url: 'http://second.example.com', signing_pubkey: 'key-2' }
        ] }), [
            'https://first.example.com:8443',
            'http://second.example.com'
        ]);
    });

    it('collapses duplicates and trailing-slash twins', function(){
        assert.deepStrictEqual(parseHubList({ hubs: [
            { api_url: 'https://hub.example.com' },
            { api_url: 'https://hub.example.com' },
            { api_url: 'https://hub.example.com/' }
        ] }), ['https://hub.example.com']);
    });

    it('refuses unsupported, credentialed and non-origin addresses', function(){
        assert.deepStrictEqual(parseHubList({ hubs: [
            { api_url: 'ftp://hub.example.com' },
            { api_url: 'https://user:pass@hub.example.com' },
            { api_url: '/relative' },
            { api_url: 'https://hub.example.com/path' },
            { api_url: 'https://hub.example.com?query=yes' },
            { api_url: 'https://hub.example.com#fragment' },
            { api_url: 'https://hub.example.com?' },
            { api_url: 'https://hub.example.com#' },
            { api_url: 'https://@hub.example.com' },
            { api_url: 'https://hub.example.com/.' },
            { api_url: 42 },
            {},
            null,
            'https://hub.example.com'
        ] }), []);
    });

    for(let [label, result] of [
        ['null', null],
        ['an object without hubs', {}],
        ['a non-array hubs value', { hubs: 'x' }],
        ['an empty hubs array', { hubs: [] }]
    ]){
        it('returns an empty array for ' + label, function(){
            assert.deepStrictEqual(parseHubList(result), []);
        });
    }
});

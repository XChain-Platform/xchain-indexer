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
const { resolveConfigEndpoint } = require('../../../../src/hub/hub_client/config_endpoint.js');

describe('resolveConfigEndpoint()', function(){
    it('prefers the trimmed config URL', function(){
        assert.deepStrictEqual(resolveConfigEndpoint({
            configUrl: '  https://config.example.com  ',
            apiUrl: 'https://api.example.com'
        }), {
            url: 'https://config.example.com',
            apiKey: '',
            enabled: true,
            notice: null
        });
    });

    it('falls back to the trimmed API URL', function(){
        assert.deepStrictEqual(resolveConfigEndpoint({
            configUrl: '   ',
            apiUrl: '  https://api.example.com  '
        }), {
            url: 'https://api.example.com',
            apiKey: '',
            enabled: true,
            notice: null
        });
    });

    it('disables the endpoint and gives notice for seeds alone', function(){
        assert.deepStrictEqual(resolveConfigEndpoint({ seedUrls: ' seed-a, seed-b ' }), {
            url: '',
            apiKey: '',
            enabled: false,
            notice: 'Hub config poll is off because no config or API address is set.'
        });
    });

    it('uses the API URL without notice when seeds are also set', function(){
        assert.deepStrictEqual(resolveConfigEndpoint({
            apiUrl: ' https://api.example.com ',
            seedUrls: ' seed-a '
        }), {
            url: 'https://api.example.com',
            apiKey: '',
            enabled: true,
            notice: null
        });
    });

    it('disables the endpoint without notice when nothing is set', function(){
        assert.deepStrictEqual(resolveConfigEndpoint({}), {
            url: '',
            apiKey: '',
            enabled: false,
            notice: null
        });
    });

    it('never promotes the default seed value to the URL', function(){
        assert.deepStrictEqual(resolveConfigEndpoint({ seedUrls: 'default' }), {
            url: '',
            apiKey: '',
            enabled: false,
            notice: 'Hub config poll is off because no config or API address is set.'
        });
    });

    it('prefers the trimmed config key and falls back to the API key', function(){
        assert.strictEqual(resolveConfigEndpoint({
            configApiKey: ' config-key ',
            apiKey: 'api-key'
        }).apiKey, 'config-key');
        assert.strictEqual(resolveConfigEndpoint({
            configApiKey: ' ',
            apiKey: ' api-key '
        }).apiKey, 'api-key');
    });

    it('treats every non-string input as unset', function(){
        assert.deepStrictEqual(resolveConfigEndpoint({
            configUrl: { url: 'https://config.example.com' },
            apiUrl: 42,
            seedUrls: ['seed-a'],
            configApiKey: true,
            apiKey: { key: 'api-key' }
        }), {
            url: '',
            apiKey: '',
            enabled: false,
            notice: null
        });
    });
});

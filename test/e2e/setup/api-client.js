/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * HTTP client for E2E tests.
 *
 * Thin wrapper over Node's built-in http module.
 * No external dependencies required.
 */

'use strict';

const http = require('http');

/**
 * Create an API client bound to a specific port on 127.0.0.1.
 * @param {number} port - The explorer's HTTP port
 * @returns {{ get: Function, baseUrl: string }}
 */
function createClient(port) {

    /**
     * Make a GET request and return parsed JSON.
     * @param {string} urlPath - e.g. '/RBTC/api/token/MYTOKEN'
     * @returns {Promise<{status: number, body: object|string}>}
     */
    function get(urlPath) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path: urlPath,
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            }, (res) => {
                let raw = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { raw += chunk; });
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, body: JSON.parse(raw) });
                    } catch (e) {
                        resolve({ status: res.statusCode, body: raw });
                    }
                });
            });
            req.on('error', reject);
            req.end();
        });
    }

    return { get, baseUrl: `http://127.0.0.1:${port}` };
}

module.exports = { createClient };

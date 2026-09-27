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

const assert = require('assert');

const {
    scrubMessage,
    redactFields,
    formatTextLine,
    readLogEnv
} = require('../../../src/observability/logShipper.js');

describe('log shipper redaction and formatting', function () {
    describe('scrubMessage', function () {
        it('redacts inline secrets and a bare bearer token without redacting a txid', function () {
            const txid = '0123456789abcdef'.repeat(4);
            const message = [
                'password=hunter2',
                'api_key: "abc"',
                'HUB_DB_SECRET=xyz',
                'Bearer abcdefghijklmnop',
                `txid=${txid}`
            ].join(' ');

            assert.strictEqual(
                scrubMessage(message),
                `password=[redacted] api_key: [redacted] HUB_DB_SECRET=[redacted] [redacted] txid=${txid}`
            );
        });
    });

    describe('redactFields', function () {
        it('redacts secret-bearing keys at every nesting depth', function () {
            const input = {
                password: 'top-level',
                public: {
                    api_key: 'nested',
                    deeper: { wif: 'deep', visible: 'safe' }
                }
            };

            assert.deepStrictEqual(redactFields(input), {
                password: '[redacted]',
                public: {
                    api_key: '[redacted]',
                    deeper: { wif: '[redacted]', visible: 'safe' }
                }
            });
        });

        it('truncates values at depth four', function () {
            assert.deepStrictEqual(
                redactFields({ one: { two: { three: { four: { five: 'hidden' } } } } }),
                { one: { two: { three: { four: '[truncated]' } } } }
            );
        });

        it('marks cyclic references', function () {
            const input = { label: 'root' };
            input.self = input;

            assert.deepStrictEqual(redactFields(input), {
                label: 'root',
                self: '[circular]'
            });
        });

        it('caps arrays at fifty entries', function () {
            const output = redactFields(Array.from({ length: 60 }, (_, index) => index));

            assert.strictEqual(output.length, 50);
            assert.deepStrictEqual(output, Array.from({ length: 50 }, (_, index) => index));
        });

        it('serializes errors and scrubs their message and stack', function () {
            const error = new TypeError('password=hunter2');
            error.stack = 'TypeError: password=hunter2\nBearer abcdefghijklmnop';

            assert.deepStrictEqual(redactFields(error), {
                name: 'TypeError',
                message: 'password=[redacted]',
                stack: 'TypeError: password=[redacted]\n[redacted]'
            });
        });
    });

    describe('formatTextLine', function () {
        it('renders one escaped text line and JSON-quotes complex field values', function () {
            const line = formatTextLine({
                ts: '2026-09-26T12:34:56.000Z',
                level: 'warn',
                service: 'indexer',
                msg: 'first line\nsecond line',
                attempt: 3,
                detail: 'two "quoted" words'
            });

            assert.strictEqual(
                line,
                '2026-09-26T12:34:56.000Z warn [indexer] first line\\nsecond line attempt=3 detail="two \\"quoted\\" words"'
            );
        });
    });

    describe('readLogEnv', function () {
        it('uses inert text defaults for an empty environment', function () {
            const config = readLogEnv({});

            assert.deepStrictEqual({
                format: config.format,
                level: config.level,
                shipEnabled: config.shipEnabled,
                url: config.url
            }, {
                format: 'text',
                level: 'info',
                shipEnabled: false,
                url: ''
            });
        });

        it('enables shipping only with a truthy flag and an HTTP or HTTPS URL', function () {
            const cases = [
                [{ LOG_SHIP_ENABLED: 'true', LOG_SHIP_URL: 'https://127.0.0.1' }, true],
                [{ LOG_SHIP_ENABLED: '1', LOG_SHIP_URL: 'http://127.0.0.1' }, true],
                [{ LOG_SHIP_ENABLED: 'false', LOG_SHIP_URL: 'https://127.0.0.1' }, false],
                [{ LOG_SHIP_URL: 'https://127.0.0.1' }, false],
                [{ LOG_SHIP_ENABLED: 'true', LOG_SHIP_URL: 'ftp://127.0.0.1' }, false],
                [{ LOG_SHIP_ENABLED: 'true', LOG_SHIP_URL: 'not a URL' }, false]
            ];

            for (const [env, expected] of cases) {
                assert.strictEqual(readLogEnv(env).shipEnabled, expected, JSON.stringify(env));
            }
        });

        it('does not copy the shipping token into any other config field', function () {
            const secret = 'unique-log-ship-token';
            const config = readLogEnv({
                LOG_SHIP_ENABLED: 'true',
                LOG_SHIP_URL: 'https://127.0.0.1',
                LOG_SHIP_TOKEN: secret
            });
            const { token, ...otherFields } = config;

            assert.strictEqual(token, secret);
            assert.ok(!JSON.stringify(otherFields).includes(secret));
        });
    });
});

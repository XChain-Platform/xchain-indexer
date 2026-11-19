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
 **********************************************************************
 *
 * XChain shared observability - SQL timing counter
 *
 * Counts MariaDB calls inside request spans and emits normalized timing
 * contract lines without changing database results or request behavior.
 *
 ********************************************************************/

'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { createSqlTimingShipper, readSqlTimingEnv } = require('./sql_timing_shipper');

const SQL_METHODS = ['query', 'execute', 'batch'];

function rate(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function scannerWord(sql, start) {
    let end = start + 1;
    while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) end += 1;
    return end;
}

function quotedEnd(sql, start, quote) {
    let cursor = start + 1;
    while (cursor < sql.length) {
        if (sql[cursor] === '\\') {
            cursor += 2;
            continue;
        }
        if (sql[cursor] === quote) {
            if (sql[cursor + 1] === quote) {
                cursor += 2;
                continue;
            }
            return cursor + 1;
        }
        cursor += 1;
    }
    return sql.length;
}

function backtickEnd(sql, start) {
    let cursor = start + 1;
    while (cursor < sql.length) {
        if (sql[cursor] !== '`') {
            cursor += 1;
            continue;
        }
        if (sql[cursor + 1] === '`') {
            cursor += 2;
            continue;
        }
        return cursor + 1;
    }
    return -1;
}

function dollarStringEnd(sql, start) {
    const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(start));
    if (!match) return -1;
    const remainder = sql.slice(start + match[0].length);
    const close = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(remainder);
    return close ? start + match[0].length + close.index + close[0].length : -1;
}

function numericEnd(sql, start) {
    const match = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(sql.slice(start));
    return match ? start + match[0].length : -1;
}

/**
 * Normalizes MariaDB SQL without retaining literals or comments.
 *
 * @param {string} sql statement text
 * @returns {string} stable literal-free statement
 */
function normalizeStatement(sql) {
    if (typeof sql !== 'string') throw new TypeError('SQL must be a string');
    let output = '';
    let cursor = 0;
    while (cursor < sql.length) {
        const ch = sql[cursor];
        if ((ch === '-' && sql[cursor + 1] === '-') || ch === '#') {
            const end = sql.slice(cursor).search(/[\r\n]/);
            cursor = end === -1 ? sql.length : cursor + end;
            output += ' ';
            continue;
        }
        if (ch === '/' && sql[cursor + 1] === '*') {
            const close = sql.indexOf('*/', cursor + 2);
            cursor = close === -1 ? sql.length : close + 2;
            output += ' ';
            continue;
        }
        if (ch === '`') {
            const end = backtickEnd(sql, cursor);
            if (end !== -1) {
                output += sql.slice(cursor, end);
                cursor = end;
                continue;
            }
        }
        if (ch === '$') {
            const dollarEnd = dollarStringEnd(sql, cursor);
            if (dollarEnd !== -1) {
                output += '?';
                cursor = dollarEnd;
                continue;
            }
            const placeholder = /^\$\d+/.exec(sql.slice(cursor));
            if (placeholder) {
                output += placeholder[0];
                cursor += placeholder[0].length;
                continue;
            }
        }
        if (ch === ':') {
            const placeholder = /^:[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(cursor));
            if (placeholder) {
                output += placeholder[0];
                cursor += placeholder[0].length;
                continue;
            }
        }
        if (ch === '_' && /^_[A-Za-z0-9]+'/.test(sql.slice(cursor))) {
            const quote = sql.indexOf("'", cursor);
            cursor = quotedEnd(sql, quote, "'");
            output += '?';
            continue;
        }
        if (/[eEnNbBxX]/.test(ch) && sql[cursor + 1] === "'") {
            cursor = quotedEnd(sql, cursor + 1, "'");
            output += '?';
            continue;
        }
        if (ch === "'" || ch === '"') {
            cursor = quotedEnd(sql, cursor, ch);
            output += '?';
            continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
            const end = scannerWord(sql, cursor);
            const word = sql.slice(cursor, end);
            output += /^(?:true|false|null)$/i.test(word) ? '?' : word;
            cursor = end;
            continue;
        }
        if (/\d/.test(ch) || (ch === '.' && /\d/.test(sql[cursor + 1] || ''))) {
            const end = numericEnd(sql, cursor);
            if (end !== -1) {
                output += '?';
                cursor = end;
                continue;
            }
        }
        output += ch;
        cursor += 1;
    }
    return output.replace(/\s+/g, ' ').trim();
}

function sqlText(args) {
    const first = args[0];
    if (typeof first === 'string') return first;
    return first && typeof first.sql === 'string' ? first.sql : '';
}

function elapsedMs(start) {
    return Number(process.hrtime.bigint() - start) / 1e6;
}

function configuredEnv(opts, fallback) {
    const source = opts.env || fallback;
    if (opts.project === undefined && opts.url === undefined && opts.apiKey === undefined) return source;
    return {
        ...source,
        SQL_TIMING_PROJECT: opts.project === undefined ? source.SQL_TIMING_PROJECT : opts.project,
        SQL_TIMING_URL: opts.url === undefined ? source.SQL_TIMING_URL : opts.url,
        SQL_TIMING_KEY: opts.apiKey === undefined ? source.SQL_TIMING_KEY : opts.apiKey
    };
}

/**
 * Creates a request-scoped SQL timing counter and sender.
 *
 * @param {object} opts counter options
 * @returns {object} middleware, wrappers, lifecycle, and configuration methods
 */
function createSqlTiming(opts = {}) {
    const storage = new AsyncLocalStorage();
    const random = typeof opts.random === 'function' ? opts.random : Math.random;
    const now = typeof opts.now === 'function' ? opts.now : () => new Date();
    const onLine = typeof opts.onLine === 'function' ? opts.onLine : null;
    const wrappedObjects = new WeakSet();
    let routePrefix = opts.routePrefix || '';
    let env = configuredEnv(opts, process.env);
    let config = readSqlTimingEnv(env);
    let requestRate = rate(env.SQL_TIMING_REQUEST_RATE, 1);
    let statementRate = rate(env.SQL_TIMING_STATEMENT_RATE, 0.05);
    let shipper = opts.deferShipper ? null : createSqlTimingShipper({
        env,
        registry: opts.registry || null,
        transport: opts.transport || null,
        console: opts.console || console
    });

    function makeSpan(route) {
        return {
            route,
            start: process.hrtime.bigint(),
            queryCount: 0,
            totalQueryMs: 0,
            statements: [],
            collectStatements: random() < statementRate,
            emit: random() < requestRate,
            rpc: false,
            done: false
        };
    }

    function emitSpan(span) {
        if (span.done) return;
        span.done = true;
        try {
            if (!span.emit || span.rpc || !span.route) return;
            const record = {
                timestamp: now().toISOString(),
                project: config.project,
                route: span.route,
                query_count: span.queryCount,
                total_query_ms: span.totalQueryMs,
                request_ms: elapsedMs(span.start)
            };
            if (span.collectStatements) {
                record.statements = span.statements;
                record.sample_rate = requestRate * statementRate;
            }
            if (onLine) onLine(record);
            if (shipper) shipper.enqueue(record);
        } catch { /* Keep timing instrumentation fail-open. */ }
    }

    function matchedRoute(req) {
        if (!req.route || typeof req.route.path !== 'string') return '';
        const method = String(req.method || 'GET').toUpperCase();
        const path = `${routePrefix}${req.baseUrl || ''}${req.route.path}` || '/';
        return `${method} ${path}`;
    }

    function middleware(req, res, next) {
        if (!config.enabled) return next();
        try {
            const span = makeSpan('');
            let finished = false;
            const finish = () => {
                if (finished) return;
                finished = true;
                try {
                    span.route = matchedRoute(req);
                    emitSpan(span);
                } catch { /* Keep response completion fail-open. */ }
            };
            res.on('finish', finish);
            res.on('close', finish);
            return storage.run(span, next);
        } catch { return next(); }
    }

    function account(span, text, start) {
        try {
            const ms = elapsedMs(start);
            span.queryCount += 1;
            span.totalQueryMs += ms;
            if (span.collectStatements && span.statements.length < 50 && text) {
                span.statements.push({ sql: normalizeStatement(text), ms });
            }
        } catch { /* Keep database calls fail-open. */ }
    }

    function wrapSqlMethod(target, name) {
        const original = target[name];
        if (typeof original !== 'function') return;
        target[name] = function wrappedSqlMethod(...args) {
            let span;
            let text = '';
            let start;
            try {
                span = storage.getStore();
                if (span) {
                    text = sqlText(args);
                    start = process.hrtime.bigint();
                }
            } catch { span = null; }
            let result;
            try { result = original.apply(this, args); } catch (error) {
                if (span) account(span, text, start);
                throw error;
            }
            if (!span) return result;
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                account(span, text, start);
            };
            try {
                if (result && typeof result.then === 'function') result.then(done, done);
                else done();
            } catch { done(); }
            return result;
        };
    }

    function wrapConnection(connection) {
        if (!connection || (typeof connection !== 'object' && typeof connection !== 'function')) return connection;
        if (wrappedObjects.has(connection)) return connection;
        try {
            for (const name of SQL_METHODS) wrapSqlMethod(connection, name);
            wrappedObjects.add(connection);
        } catch { /* Return an unmodified connection if wrapping fails. */ }
        return connection;
    }

    /** Wraps a MariaDB pool and its acquired connections in place. */
    function wrapPool(pool) {
        if (!config.enabled || !pool || (typeof pool !== 'object' && typeof pool !== 'function')) return pool;
        if (wrappedObjects.has(pool)) return pool;
        try {
            for (const name of SQL_METHODS) wrapSqlMethod(pool, name);
            if (typeof pool.getConnection === 'function') {
                const getConnection = pool.getConnection;
                pool.getConnection = function wrappedGetConnection(...args) {
                    const result = getConnection.apply(this, args);
                    try {
                        if (result && typeof result.then === 'function') result.then(wrapConnection, () => {});
                        else wrapConnection(result);
                    } catch { /* Return the original acquisition result. */ }
                    return result;
                };
            }
            wrappedObjects.add(pool);
        } catch { /* Return an unmodified pool if wrapping fails. */ }
        return pool;
    }

    /** Wraps each JSON-RPC method in an independently emitted child span. */
    function wrapRpcMethods(methods) {
        if (!config.enabled || !methods || typeof methods !== 'object') return methods;
        // Keep the table prototype-free so a router never dispatches inherited names like "constructor".
        const wrapped = Object.create(null);
        for (const [name, method] of Object.entries(methods)) {
            if (typeof method !== 'function') {
                wrapped[name] = method;
                continue;
            }
            wrapped[name] = function wrappedRpcMethod(...args) {
                let parent;
                let span;
                try {
                    parent = storage.getStore();
                    if (parent) parent.rpc = true;
                    if (parent) span = makeSpan(`POST ${routePrefix}/rpc/${name}`);
                } catch { parent = null; }
                if (!parent) return method.apply(this, args);
                return storage.run(span, () => {
                    let result;
                    try { result = method.apply(this, args); } catch (error) {
                        emitSpan(span);
                        throw error;
                    }
                    try {
                        if (result && typeof result.then === 'function') {
                            result.then(() => emitSpan(span), () => emitSpan(span));
                            return result;
                        }
                    } catch { /* Return the original method result. */ }
                    emitSpan(span);
                    return result;
                });
            };
        }
        return wrapped;
    }

    /** Reconfigures the shared instance without invalidating wrapped pools. */
    function configure(next = {}) {
        if (shipper) shipper.stop().catch(() => {});
        env = configuredEnv(next, env);
        config = readSqlTimingEnv(env);
        requestRate = rate(env.SQL_TIMING_REQUEST_RATE, 1);
        statementRate = rate(env.SQL_TIMING_STATEMENT_RATE, 0.05);
        if (next.routePrefix !== undefined) routePrefix = next.routePrefix;
        shipper = createSqlTimingShipper({
            env,
            registry: next.registry || null,
            transport: next.transport || null,
            console: next.console || console
        });
        return api;
    }

    /** Stops the sender after one final flush attempt. */
    function stop() { return shipper ? shipper.stop() : Promise.resolve(); }

    const api = {
        middleware,
        wrapPool,
        wrapRpcMethods,
        configure,
        stop,
        flush: () => shipper ? shipper.flush() : Promise.resolve(),
        get enabled() { return config.enabled; },
        get buffer() { return shipper ? shipper.buffer : []; },
        get stats() { return shipper ? shipper.stats : { shipped: 0, dropped: 0, failures: 0 }; }
    };
    return api;
}

module.exports = { createSqlTiming, normalizeStatement };

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// installMethods: installs method bags on a prototype as non-enumerable
// properties while keeping accessors and attributes as written.

const assert = require('assert');
const installMethods = require('../../../../src/actions/actions_class/install_methods.js');

describe('installMethods @regression @tier3', () => {
    it('installs methods as own, non-enumerable, callable properties', () => {
        const proto = {};
        installMethods(proto, [{ a() { return 1; } }]);
        assert.deepStrictEqual(Object.keys(proto), []);
        assert.ok(Object.prototype.hasOwnProperty.call(proto, 'a'));
        assert.strictEqual(Object.getOwnPropertyDescriptor(proto, 'a').enumerable, false);
        assert.strictEqual(proto.a(), 1);
    });

    it('keeps getter and setter functions', () => {
        const get = () => 7;
        const set = () => {};
        const part = {};
        Object.defineProperty(part, 'g', { get, set, enumerable: true, configurable: true });
        const proto = {};
        installMethods(proto, [part]);
        const desc = Object.getOwnPropertyDescriptor(proto, 'g');
        assert.strictEqual(desc.get, get);
        assert.strictEqual(desc.set, set);
        assert.strictEqual(desc.enumerable, false);
    });

    it('keeps writable false', () => {
        const part = {};
        Object.defineProperty(part, 'k', { value: 5, writable: false, enumerable: true, configurable: true });
        const proto = {};
        installMethods(proto, [part]);
        const desc = Object.getOwnPropertyDescriptor(proto, 'k');
        assert.strictEqual(desc.writable, false);
        assert.strictEqual(desc.value, 5);
    });

    it('installs symbol-keyed properties', () => {
        const sym = Symbol('s');
        const proto = {};
        installMethods(proto, [{ [sym]() { return 'x'; } }]);
        assert.strictEqual(proto[sym](), 'x');
        assert.strictEqual(Object.getOwnPropertyDescriptor(proto, sym).enumerable, false);
    });

    it('lets a later part overwrite an earlier one without throwing', () => {
        const proto = {};
        assert.doesNotThrow(() => installMethods(proto, [{ a() { return 1; } }, { a() { return 2; } }]));
        assert.strictEqual(proto.a(), 2);
    });

    it('changes nothing for an empty parts list', () => {
        const proto = { existing: 1 };
        installMethods(proto, []);
        assert.deepStrictEqual(Reflect.ownKeys(proto), ['existing']);
        assert.strictEqual(proto.existing, 1);
    });
});

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
 * XChain Indexer - Actions class: method installer
 *
 * Installs plain objects of methods onto a class prototype NON-ENUMERABLE, the shape a
 * class body produces: the class reaches them as this.<method>, suites can stub them
 * through the prototype, and for-in over an instance or its prototype stays empty. A
 * plain Object.assign would make every installed method enumerable, which a class
 * method never is. Same install as bet.js and db/index.js use for their mixins.
 *
 *********************************************************************/

// Define every own property of each part on proto, keeping its getter/setter/value,
// writable and configurable exactly as written, with enumerable forced off.
function installMethods(proto, parts){
    for(const part of parts){
        const descriptors = Object.getOwnPropertyDescriptors(part);
        for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
        Object.defineProperties(proto, descriptors);
    }
}

module.exports = installMethods;

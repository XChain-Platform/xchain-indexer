// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const { registerHooks } = require('node:module');

const MOCHA_CJS_CLI_MODULE = /\/lib\/cli\/(?:run-helpers|options|collect-files)$/;

// Stryker 10 resolves these private Mocha CLI modules without the .cjs extension.
registerHooks({
    resolve(specifier, context, nextResolve) {
        if(MOCHA_CJS_CLI_MODULE.test(specifier))
            return nextResolve(`${specifier}.cjs`, context);
        return nextResolve(specifier, context);
    },
});

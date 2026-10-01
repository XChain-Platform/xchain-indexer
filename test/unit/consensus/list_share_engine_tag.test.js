/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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

const { ENGINE_TAGS } = require('../../../src/consensus/equivocation_header.js');

const PRE_LIST_SHARE_TAGS = {
    DEX: 'XDEX',
    XCALL: 'XCALL',
    ATTEST: 'XATTEST',
    ORACLE: 'XORACLE',
    ORACLE_BATCH: 'XORACLEB',
    CHECKPOINT: 'XCHECKPOINT',
    CONFIG: 'XCONFIG',
    NODEPROOF: 'XNODEPROOF',
    ROLLCALL: 'XROLLCALL',
    BRIDGE: 'XBRIDGE',
    POLICY: 'XPOLICY',
};

describe('LIST_SHARE engine tag', function () {
    it('is exposed through the equivocation header consensus module', function () {
        assert.strictEqual(ENGINE_TAGS.LIST_SHARE, 'XLISTSHARE');
    });

    it('leaves every existing engine tag unchanged', function () {
        const existing = { ...ENGINE_TAGS };
        delete existing.LIST_SHARE;
        assert.deepStrictEqual(existing, PRE_LIST_SHARE_TAGS);
    });
});

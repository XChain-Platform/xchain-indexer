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

// Live shapes for the index_memos.memo precondition: any utf8mb4 column has had its widen
// whatever its collation, so only a narrower charset, an absent column or an absent table
// leaves the migration to run.
const MEMO = '2026-08-19-utf8mb4-index-memos-memo.sql';
const memoTable = (definition) => 'CREATE TABLE index_memos (' + definition + ')';
const memoShape = (name, baseline, ...ddl) => ({ name, file: MEMO, baseline, ddl });

module.exports = [
    memoShape('memo column already utf8mb4 with the binary collation', true,
        memoTable('memo VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL')),
    memoShape('memo column already utf8mb4 with the folding collation', true,
        memoTable('memo VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL')),
    memoShape('memo column still utf8', false,
        memoTable('memo VARCHAR(250) CHARACTER SET utf8 COLLATE utf8_general_ci NOT NULL')),
    memoShape('index_memos without the memo column', false, memoTable('other VARCHAR(250) NOT NULL')),
    memoShape('index_memos table absent', false),
];

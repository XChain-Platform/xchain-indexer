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

// Live shapes for the NOT NULL half of the raw-wire utf8mb4 widen. The tables are built
// from the registry's manual entries, so a registry change moves these shapes with it.
// The precondition may baseline the file only when every manual column exists in its
// declared utf8mb4 shape, and the startup assertion names the file only when a manual
// column is narrow.
const utf8mb4Columns = require('../../../../src/chain/utf8mb4_columns.js');

const FILE = '2026-09-02-utf8mb4-raw-wire-fields-not-null.sql';
const ASSERTION = 'assertRegisteredUtf8mb4ColumnsStayWide';
const MANUAL = utf8mb4Columns.forMode('manual');

// One CREATE TABLE per manual table, each column in its declared shape unless an option
// names it as 'table.column': narrow builds it utf8mb3, binary gives it utf8mb4_bin,
// nullable drops NOT NULL, and omit leaves it out.
function manualTables({ narrow, binary, nullable, omit } = {}) {
    const tables = new Map();
    for (const entry of MANUAL) {
        const key = entry.table + '.' + entry.column;
        if (!tables.has(entry.table)) tables.set(entry.table, []);
        if (key === omit) continue;
        const charset = key === narrow ? 'utf8mb3' : 'utf8mb4';
        const collation = key === binary ? 'utf8mb4_bin' : charset + '_general_ci';
        const tail = key === nullable ? 'NULL' : entry.tail;
        tables.get(entry.table).push('`' + entry.column + '` ' + entry.type + ' CHARACTER SET ' + charset +
            ' COLLATE ' + collation + (tail ? ' ' + tail : ''));
    }
    return [...tables].map(([table, columns]) => 'CREATE TABLE `' + table + '` (id INT NOT NULL PRIMARY KEY' +
        columns.map(column => ', ' + column).join('') + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
}

const shape = (name, baseline, ddl = []) => ({ name, file: FILE, baseline, ddl });
const cases = [
    shape('every manual raw-wire column already utf8mb4', true, manualTables()),
    shape('contracts.code still utf8mb3', false, manualTables({ narrow: 'contracts.code' })),
    shape('attests.provider_id still utf8mb3', false, manualTables({ narrow: 'attests.provider_id' })),
    shape('deposits.amount utf8mb4 with a binary collation', false, manualTables({ binary: 'deposits.amount' })),
    shape('reward_claims.amount utf8mb4 but nullable', false, manualTables({ nullable: 'reward_claims.amount' })),
    shape('gated_files without gate_ticker', false, manualTables({ omit: 'gated_files.gate_ticker' })),
    shape('manual raw-wire tables absent', false),
];

const MESSAGES_NARROW = 'CREATE TABLE messages (id INT NOT NULL PRIMARY KEY, ' +
    'coin VARCHAR(4) CHARACTER SET utf8mb3 NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
const assertion = (name, refuses, ddl = []) => ({ name, method: ASSERTION, refuses, ddl });
const assertions = [
    assertion('contracts.code narrowed to utf8mb3', new RegExp('contracts\\.code \\(utf8mb3\\)[\\s\\S]*--file ' +
        FILE.replace(/[.]/g, '\\.')), manualTables({ narrow: 'contracts.code' })),
    assertion('only the auto column messages.coin narrowed to utf8mb3',
        /^(?![\s\S]*not-null\.sql)[\s\S]*messages\.coin \(utf8mb3\)\. Restore the registered charset/,
        manualTables().concat([MESSAGES_NARROW])),
    assertion('every manual raw-wire column utf8mb4', undefined, manualTables()),
    assertion('manual raw-wire tables absent', undefined),
];

module.exports = { cases, assertions };

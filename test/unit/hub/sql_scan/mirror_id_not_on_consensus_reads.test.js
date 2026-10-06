'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    extractSqlLiterals,
    findIndirectTableSites,
    findMirrorIdUses,
} = require('../../../helpers/sql_literal_scan');

const DB_ROOT = path.resolve(__dirname, '../../../../src/db');
const MIRRORED_TABLES = [
    'price_snapshots',
    'oracle_prices',
    'cross_chain_matches',
    'cross_chain_calls',
    'capability_snapshots',
    'bridge_transfers',
    'policy_snapshots',
    'list_snapshots',
    'state_checkpoints',
    'anchor_reward_attestations',
    'attestation_responses',
];
const INDIRECT_SITES = [
    'attests/validator_stats.js',
    'contracts/delegation_rotation.js',
    'database/controllers_vm.js',
    'database/migration_tables.js',
    'database/startup_assertions.js',
    'lists/rematch.js',
    'misc/index.js',
];

function javascriptFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) return javascriptFiles(absolute);
            return entry.isFile() && entry.name.endsWith('.js') ? [absolute] : [];
        })
        .sort();
}

function relativeFile(file) {
    return path.relative(DB_ROOT, file).split(path.sep).join('/');
}

function violations(source, file) {
    return extractSqlLiterals(source, file).flatMap(({ literal, line }) =>
        findMirrorIdUses(literal, MIRRORED_TABLES).map(use => ({ line, ...use }))
    );
}

describe('mirrored ids stay out of consensus reads', function () {
    it('rejects direct mirrored-table id use in every src/db SQL literal', function () {
        const found = [];
        for (const file of javascriptFiles(DB_ROOT)) {
            const source = fs.readFileSync(file, 'utf8');
            for (const use of violations(source, file)) {
                found.push(`${relativeFile(file)}:${use.line} ${use.clause} ${use.reference}`);
            }
        }

        assert.deepStrictEqual(found, [], `mirrored id consensus reads:\n${found.join('\n')}`);
    });

    it('keeps every indirect mirrored-table construction site reviewed', function () {
        const found = new Set();
        for (const file of javascriptFiles(DB_ROOT)) {
            const source = fs.readFileSync(file, 'utf8');
            if (findIndirectTableSites(source, file, MIRRORED_TABLES).length > 0) {
                found.add(relativeFile(file));
            }
        }

        assert.deepStrictEqual([...found].sort(), [...INDIRECT_SITES].sort());
    });

    it('catches a property-held violating literal', function () {
        const source = "const query = { sql: 'SELECT * FROM price_snapshots p ORDER BY p.id' };";
        assert.deepStrictEqual(violations(source, 'property.js'), [
            { line: 1, clause: 'ORDER BY', reference: 'p.id' },
        ]);
    });

    it('catches an array-held violating literal', function () {
        const source = "const queries = ['SELECT * FROM oracle_prices WHERE id > 4'];";
        assert.deepStrictEqual(violations(source, 'array.js'), [
            { line: 1, clause: 'WHERE', reference: 'id' },
        ]);
    });

    it('catches a concatenated violating literal', function () {
        const source = 'const query = '
            + "'SELECT * FROM state_checkpoints s JOIN state_checkpoints p ON s.id = p.id' + ' LIMIT 1';";
        assert.deepStrictEqual(violations(source, 'concatenated.js'), [
            { line: 1, clause: 'JOIN ON', reference: 's.id' },
            { line: 1, clause: 'JOIN ON', reference: 'p.id' },
        ]);
    });
});

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
 **********************************************************************/

// test/unit/consensus/blockhash_conformance_twin.test/helpers/preimage_shape.js
//
// The object shape of the ledger and contract hash preimages. getDataHash runs
// JSON.stringify over these objects, so each key name, the order the keys are
// declared in, the gatherer that fills each key and the block it binds are all
// hash inputs, exactly like the SQL the other cases compare.
//
// A factory rather than a plain export so the helper reuses the calling suite's
// own extraction and comment-stripping functions. The file is mirrored in
// xchain-indexer and xchain-sync; keep the two copies identical below the header.

'use strict';

// Pin each ledger preimage key to the indexer method that fills it, in declared order.
const LEDGER_GATHERERS = [
    ['credits', 'getBlockHashCreditRows'],
    ['debits',  'getBlockHashDebitRows'],
    ['escrows', 'getBlockHashEscrowRows']
];

// Pin each contract preimage key to the indexer method that fills it, in declared order.
const CONTRACT_GATHERERS = [
    ['contracts',   'getBlockHashContractRows'],
    ['state',       'getBlockHashContractStateRows'],
    ['executions',  'getBlockHashExecutionRows'],
    ['emissions',   'getBlockHashEmissionRows'],
    ['deposits',    'getBlockHashDepositRows'],
    ['withdrawals', 'getBlockHashWithdrawalRows']
];

// Every indexer gathering method that must bind the block being hashed.
const BLOCK_BOUND_METHODS = LEDGER_GATHERERS.concat([['actions', 'getBlockHashActionRows']], CONTRACT_GATHERERS)
    .map(([, method]) => method);

function make({ assert, stripComments, extractFunction }){
    // Comment-stripped, whitespace-collapsed body of the function sigRe names.
    function collapsed(src, sigRe, from){
        return stripComments(extractFunction(src, sigRe, from)).replace(/\s+/g, ' ');
    }

    // Split `name = { ... };` into its entries, failing when the literal is absent.
    function literalEntries(fn, name, from){
        const m = fn.match(new RegExp('(?:const|let) ' + name + ' = \\{([^}]*)\\};'));
        assert.ok(m, from + ': the object literal assigned to `' + name + '` was not found');
        return m[1].split(',').map(s => s.trim()).filter(Boolean);
    }

    // Read the indexer literal as [key, method, argument] for each `key: await this.method(arg)`.
    function indexerLiteral(fn, name, from){
        return literalEntries(fn, name, from).map(entry => {
            const t = entry.match(/^(\w+): await this\.(\w+)\((\w+)\)$/);
            assert.ok(t, from + ': preimage entry is not `key: await this.method(arg)`: ' + entry);
            return [t[1], t[2], t[3]];
        });
    }

    // Read the follower initializer `{ a: [], b: [] }` as its key list.
    function initializerKeys(fn, name, from){
        return literalEntries(fn, name, from).map(entry => {
            const t = entry.match(/^(\w+): \[\]$/);
            assert.ok(t, from + ': initializer entry is not `key: []`: ' + entry);
            return t[1];
        });
    }

    // Read every `name.key = await <db>.doQueryStrict(args);` fill as [key, args], in order.
    function fills(fn, name, dbExpr){
        const re = new RegExp(name + '\\.(\\w+) = await ' + dbExpr.replace(/\./g, '\\.') +
            '\\.doQueryStrict\\(([^;]*?)\\);', 'g');
        const out = [];
        let m;
        while((m = re.exec(fn)) !== null) out.push([m[1], m[2]]);
        return out;
    }

    // Prove a follower object is declared, then filled, in the pinned key order with the pinned bind.
    function assertFollowerObject(fn, name, dbExpr, want, bindRe, from){
        const keys = want.map(([key]) => key);
        assert.deepStrictEqual(initializerKeys(fn, name, from), keys,
            from + ' declares the `' + name + '` preimage keys in a different order or under different ' +
            'names; JSON.stringify serializes them in declared order, so this forks the hash');
        const filled = fills(fn, name, dbExpr);
        assert.deepStrictEqual(filled.map(([key]) => key), keys,
            from + ' fills `' + name + '` in a different order than its keys, so the SQL compared at ' +
            'position i no longer lands under the key the indexer gives it');
        for(const [key, args] of filled)
            assert.ok(bindRe.test(args), from + ' binds `' + name + '.' + key + '` to something other ' +
                'than the block being hashed: ' + args);
        return filled;
    }

    // The indexer's preimage objects, checked against the pinned keys, gatherers and binds.
    function assertIndexerPreimage(src){
        const ledgerFn = collapsed(src, /async getBlockHashLedgerRows\(block_index\)\{/, 'db/actions.js');
        const contractFn = collapsed(src, /async getBlockHashContractData\(block_index\)\{/, 'db/actions.js');
        const shape = {
            ledger:    indexerLiteral(ledgerFn, 'ledger', 'db.getBlockHashLedgerRows'),
            contracts: indexerLiteral(contractFn, 'contracts_data', 'db.getBlockHashContractData')
        };
        for(const [from, got, want] of [['db.getBlockHashLedgerRows', shape.ledger, LEDGER_GATHERERS],
                                        ['db.getBlockHashContractData', shape.contracts, CONTRACT_GATHERERS]]){
            assert.deepStrictEqual(got.map(([key, method]) => [key, method]), want,
                from + ' changed a preimage key name, its order, or the gatherer that fills it; ' +
                'JSON.stringify hashes the keys in declared order, so every follower forks');
            for(const [key, , arg] of got)
                assert.strictEqual(arg, 'block_index', from + ' gathers `' + key + '` for ' + arg +
                    ' instead of the block being hashed');
        }
        for(const method of BLOCK_BOUND_METHODS){
            const fn = collapsed(src, new RegExp('async ' + method + '\\(block_index\\)\\{'), 'db/actions.js');
            assert.strictEqual(fn.split('this.doQuery(').length - 1, 1,
                'db.' + method + ' must run exactly one query');
            assert.strictEqual(fn.split('return this.doQuery(query, [block_index]);').length - 1, 1,
                'db.' + method + ' must bind its query to [block_index], the block being hashed');
        }
        return shape;
    }

    // BlockHasher's preimage objects, checked against the same pins.
    function assertBlockHasherPreimage(src){
        const from = 'BlockHasher.computeBlockHashes';
        const ledgerFn = collapsed(src, /async function getLedgerHashData\(height\)\{/, 'block_hasher.js');
        const contractFn = collapsed(src, /async function getContractsHashData\(height\)\{/, 'block_hasher.js');
        const actionsFn = collapsed(src, /async function getActionsHashData\(height\)\{/, 'block_hasher.js');
        const bound = /, \[height\]$/;
        const ledger = assertFollowerObject(ledgerFn, 'ledger', 'this.db', LEDGER_GATHERERS, bound, from);
        const contracts = assertFollowerObject(contractFn, 'contracts', 'this.db', CONTRACT_GATHERERS, bound, from);
        assert.strictEqual(actionsFn.split('this.db.doQueryStrict(').length - 1, 1, from + ' actions must run one query');
        assert.ok(/ASC`, \[height\]\);/.test(actionsFn), from + ' must bind the actions query to [height]');
        return { ledger: ledger.map(([key]) => key), contracts: contracts.map(([key]) => key) };
    }

    return { assertIndexerPreimage, assertBlockHasherPreimage, assertFollowerObject, collapsed };
}

module.exports = { LEDGER_GATHERERS, CONTRACT_GATHERERS, BLOCK_BOUND_METHODS, make };

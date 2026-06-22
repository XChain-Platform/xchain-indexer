/*********************************************************************
 * test/unit/prepass-error-skip.test.js
 *
 * #4888: the deterministic index-id pre-pass (assignActionAddressIds)
 * must NOT intern index_addresses ids for an action that was already
 * rejected before its handler (unknown / not-yet-activated ACTION). Such
 * an action does nothing, so minting ids for its wire-field addresses is
 * pure id residue. A semantic rejection INSIDE the handler still interns,
 * by design (the pre-pass pins id-assignment ORDER; that residue is
 * deterministic and foreclosed pre-launch by clean reindex).
 *
 * Pure: a stubbed indexerDb, no MariaDB. Runs on Node 22.
 *********************************************************************/

'use strict';

process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';

const assert  = require('assert');
const Actions = require('../../src/actions.js');
const Utility = require('../../src/utility.js');
const { getTestConfig } = require('../fixtures/config');

const SRC_ADDR  = 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef'; // valid regtest p2pkh
const NEW_DEST  = 'n4VQ5YdHf7hLQ2gWQYYrcxoE5B7nWuDFNF'; // fresh valid regtest p2pkh (no id yet)

// Build an Actions instance whose indexerDb records every createAddress call. A
// non-null transactionConnection puts the pre-pass in its block-processing mode.
function makeActions() {
    const created = [];
    const indexerDb = {
        transactionConnection: {},          // in a block transaction
        blockIndex:            100,
        getAddressId:          async () => null,   // every candidate is "new"
        createAddress:         async (addr) => { created.push(addr); return created.length; }
    };
    const indexer = {
        config: getTestConfig(), util: new Utility(), mapper: {},
        decoderDb: null, indexerDb, protocolChanges: {}
    };
    return { actions: new Actions(indexer), created };
}

describe('assignActionAddressIds: pre-handler-error skip (#4888) @regression @tier1', function () {

    const params = ('0|XCHAIN|5|' + NEW_DEST).split('|'); // MINT format 0, fresh DESTINATION
    const data   = { FORMAT: 0, ACTION: 'MINT', BLOCK_INDEX: 100, SOURCE: SRC_ADDR };

    it('interns the fresh destination id when the action has NO pre-handler error', async function () {
        const { actions, created } = makeActions();
        await actions.assignActionAddressIds('MINT', params, data, null);
        assert.deepStrictEqual(created, [NEW_DEST], 'a clean MINT interns its new destination id');
    });

    it('does NOT intern any id when the action was rejected before the handler', async function () {
        const { actions, created } = makeActions();
        await actions.assignActionAddressIds('MINT', params, data, 'invalid: ACTION is not yet activated');
        assert.deepStrictEqual(created, [], 'a pre-handler-rejected action mints no index ids');
    });
});

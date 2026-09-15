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

// test/unit/hub/hash_coverage.test/content_parity.test.js
//
// Covers the declared content-parity exclusions and lookup bounds.

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const lifecycle = require('../../../../src/hub/table_lifecycle.js');
const { readRollbackSource } = require('../../../helpers/rollback_source.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../../../..', rel), 'utf8');

// ── Advisory content-parity coverage ──────────────────────────
//
// The registry's CONTENT_PARITY_* block is the coverage contract for the
// advisory TABLE_CONTENT_PARITY_CHECK that xchain-sync computes and compares.
// The compute side lives in that repo, but the DECLARATION lives here, in the
// byte-identical twin, so this repo carries the guards that keep the
// declaration honest: xchain-sync's own suite cannot fail on an indexer-side
// registry edit that never gets copied over.
describe('Hash coverage guard @regression', function () {
    describe('content-parity coverage declaration', function () {

        it('the operator carve-outs are exactly markets (indexer) and dispensers (decoder)', function () {
            // Pinned to the 2026-08-11 ruling. Each carve-out is a replicated table
            // deliberately left with NO content commitment, so widening this set is an
            // operator decision rather than a code change.
            assert.deepStrictEqual(
                lifecycle.CONTENT_PARITY_CARVE_OUTS.map(c => c.dbType + ':' + c.table).sort(),
                ['decoder:dispensers', 'indexer:markets']);
            for (const c of lifecycle.CONTENT_PARITY_CARVE_OUTS)
                assert.ok(c.reason && c.reason.length > 20, `${c.table} carve-out must carry its reason`);
            // dbType-scoped: this repo's own action-scoped dispensers table is COVERED;
            // only the decoder table of that name is out.
            assert.strictEqual(lifecycle.contentParityCarveOut('dispensers', 'indexer'), null);
            assert.ok(lifecycle.contentParityCarveOut('dispensers', 'decoder'));
        });

        it('the mutable exclusion class is derived from the state_hash declarations, not hand-listed', function () {
            // Those tables are excluded from the window checksum because an in-place
            // edit in a later block moves content inside an already-published window,
            // AND because the enforced state_hash already commits them. Deriving the
            // set means a new mutation class cannot join the hash without joining the
            // exclusion, or leave the hash while staying excluded.
            assert.deepStrictEqual(lifecycle.contentParityMutableTables().sort(),
                lifecycle.hashClassTables('state_hash').sort());
            for (const t of ['stakes', 'bets', 'tokens', 'credits'])
                assert.ok(lifecycle.contentParityMutableTables().includes(t),
                    `${t} mutates in place; it must ride state_hash rather than the content window`);
        });
    });
});

describe('Hash coverage guard @regression', function () {
    describe('content-parity coverage declaration', function () {
        it('every streamed table is content-parity covered unless it is in one of the two declared classes', function () {
            // The finding in one assertion, from this side of the twin: a replicated
            // table that is neither checked nor knowingly excluded is exactly the
            // silent gap this suite was raised for.
            const topo    = lifecycle.streamTopology();
            const streamed = [].concat(topo.blockScoped, topo.txScoped, topo.actionScoped, topo.index, topo.special);
            const mutable  = new Set(lifecycle.contentParityMutableTables());
            const orphans  = streamed.filter(t =>
                !mutable.has(t) && lifecycle.contentParityCarveOut(t, 'indexer') === null &&
                lifecycle.entry(t) === null);
            assert.deepStrictEqual(orphans, [],
                `streamed tables with no registry entry to classify them: ${orphans.join(', ')}`);
            // The carve-out must be a table that actually replicates, or the
            // declaration is describing something that no longer exists.
            for (const c of lifecycle.CONTENT_PARITY_CARVE_OUTS.filter(c => c.dbType === 'indexer'))
                assert.ok(lifecycle.entry(c.table), `${c.table} carve-out names a table with no registry entry`);
        });
    });
});

describe('Hash coverage guard @regression', function () {
    describe('content-parity coverage declaration', function () {
        it('excluded columns name real, deliberately-unreplicated values', function () {
            // blocks.id is the local AUTO_INCREMENT surrogate the sync applier strips;
            // contract_state.state_key_bin is database-GENERATED; sync_meta.id and
            // sync_meta.logged_at are omitted from the streamed row ServerPoller builds
            // by hand, so the follower assigns its own; contract_emissions.id is the same
            // shape again, an AUTO_INCREMENT the per-block stream never carries (it names
            // execution_index/emitted_action/action_index/position explicitly). Hashing
            // any of them would turn a by-design difference into a permanent false alarm.
            // validator_rewards.id is the same class arrived at by a different route: the
            // row streams with the source id, but the RB-ANCHOR reorg restore re-INSERTs a
            // deleted loser WITHOUT naming id, so each side mints its own and
            // ClientApplier.ignoreTables makes that permanent.
            assert.deepStrictEqual(Object.keys(lifecycle.CONTENT_PARITY_EXCLUDED_COLUMNS).sort(),
                ['blocks', 'contract_emissions', 'contract_state', 'sync_meta', 'validator_rewards']);
            assert.deepStrictEqual(lifecycle.contentParityExcludedColumns('blocks'), ['id']);
            assert.deepStrictEqual(lifecycle.contentParityExcludedColumns('contract_emissions'), ['id']);
            assert.deepStrictEqual(lifecycle.contentParityExcludedColumns('contract_state'), ['state_key_bin']);
            assert.deepStrictEqual(lifecycle.contentParityExcludedColumns('sync_meta'), ['id', 'logged_at']);
            assert.deepStrictEqual(lifecycle.contentParityExcludedColumns('validator_rewards'), ['id']);
            assert.ok(/state_key_bin/.test(read('src/sql/contract_state.sql')),
                'contract_state.state_key_bin is no longer in the schema; the exclusion is stale');
            assert.ok(/id\s+BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY/
                .test(read('src/sql/contract_emissions.sql')),
                'contract_emissions.id is no longer a local AUTO_INCREMENT; the exclusion is stale');
            assert.ok(/id\s+BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY/
                .test(read('src/sql/validator_rewards.sql')),
                'validator_rewards.id is no longer a local AUTO_INCREMENT; the exclusion is stale');
            // The exclusion must not outlive its reason: it is justified ONLY by the
            // RB-ANCHOR restore minting the id locally on each side. If that INSERT ever
            // names id, both sides agree again and the column belongs back in the preimage.
            const rbAnchorInsert = (readRollbackSource()
                .match(/INSERT IGNORE INTO validator_rewards\s*\n?\s*\(([^)]*)\)/) || [])[1];
            assert.ok(rbAnchorInsert,
                'the RB-ANCHOR validator_rewards restore INSERT was not found in the rollback module; ' +
                're-check why validator_rewards.id is excluded from the content-parity preimage');
            assert.ok(!/\bid\b/.test(rbAnchorInsert.replace(/_id\b/g, '')),
                'the RB-ANCHOR restore now names validator_rewards.id, so the two sides no longer ' +
                'mint it locally; drop the content-parity exclusion instead of leaving it stale');
            assert.deepStrictEqual(lifecycle.contentParityExcludedColumns('actions'), [],
                'a table with nothing excluded must hash every column');
        });

        it('the two reorg-scoped lookups bound by block; the inert ones bound by id', function () {
            // index_addresses / index_tickers carry the block stamp that makes their
            // ids reorg-reproducible, so their window is a block range. The inert
            // lookups have no block column at all and ride a published id ceiling.
            for (const t of ['index_addresses', 'index_tickers'])
                assert.strictEqual(lifecycle.contentParityLookupBound(t, 'indexer'), 'block');
            for (const t of ['index_actions', 'index_statuses', 'index_transactions'])
                assert.strictEqual(lifecycle.contentParityLookupBound(t, 'indexer'), 'id');
            // The decoder schema stamps no block on its lookups.
            assert.strictEqual(lifecycle.contentParityLookupBound('index_addresses', 'decoder'), 'id');
        });
    });
});

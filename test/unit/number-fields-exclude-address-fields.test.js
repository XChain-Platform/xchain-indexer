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
 *********************************************************************/

/*********************************************************************
 *
 * Guard: NUMBER_FIELDS and the address-bearing fields must not overlap.
 *
 * normalizeDataValues() nulls every NUMBER_FIELDS entry whose value is not
 * numeric. An ADDRESS is never numeric, so listing an address-bearing field
 * there silently nulls it for STORAGE on every single action - the ledger
 * still moves (credits/debits read the un-normalized data), so nothing looks
 * broken, and the column is simply always NULL.
 *
 * Found 2026-08-27 on RDOGE: ISSUE.TRANSFER_SUPPLY sat in NUMBER_FIELDS, so
 * `issues.transfer_supply_id` could never be populated on any chain. Two
 * consequences, one cosmetic and one not:
 *
 *   - the tx detail page cannot render the transfer-supply destination
 *     (the field it reads is NULL even though tx_data carries the address);
 *   - rollback.js builds its balance-refresh address set from
 *     `m.transfer_supply_id` (the `address3` column of its issues query), so
 *     a reorg that rolls back such an ISSUE never recomputes the RECIPIENT's
 *     balance, leaving a stale balance row behind.
 *
 * A per-field regression test would have caught that one field. This checks
 * the whole class, so the next address field added to the wrong list fails
 * here instead of on a reorg.
 *
 ********************************************************************/

const assert = require('assert');
const path   = require('path');

const { ADDRESS_REF_FIELDS } = require(path.join(__dirname, '..', '..', 'src', 'addressRefFields.js'));
const Config                 = require(path.join(__dirname, '..', '..', 'src', 'config.js'));

// The config module shape differs across call sites (class vs factory vs plain
// object); resolve it to the plain settings object either way.
function loadConfig() {
    if (Config && Array.isArray(Config.NUMBER_FIELDS)) return Config;
    if (typeof Config === 'function') {
        try { return new Config(); } catch (_) { /* not a constructor */ }
        try { return Config(); }     catch (_) { /* not a factory */ }
    }
    if (Config && typeof Config.getConfig === 'function') return Config.getConfig();
    if (Config && Config.config) return Config.config;
    return Config;
}

describe('NUMBER_FIELDS excludes address-bearing fields @regression', function () {

    it('exposes both lists', function () {
        const config = loadConfig();
        assert.ok(config && Array.isArray(config.NUMBER_FIELDS),
            'config.NUMBER_FIELDS is not an array - update this guard to match the config shape');
        assert.ok(ADDRESS_REF_FIELDS && typeof ADDRESS_REF_FIELDS === 'object',
            'ADDRESS_REF_FIELDS export missing');
    });

    it('no address-bearing field is numeric-normalized', function () {
        const config  = loadConfig();
        const numbers = new Set(config.NUMBER_FIELDS);

        const offenders = [];
        for (const action of Object.keys(ADDRESS_REF_FIELDS)) {
            for (const entry of ADDRESS_REF_FIELDS[action]) {
                const field = entry && entry.field;
                // LIST.ITEM holds an address only when the list TYPE says so, and
                // TYPE itself is legitimately numeric; the field is not stored as
                // an address column, so it is exempt.
                if (!field || entry.listType) continue;
                if (numbers.has(field)) offenders.push(action + '.' + field);
            }
        }

        assert.deepStrictEqual(offenders, [],
            'these address fields are in NUMBER_FIELDS and will be nulled for storage by ' +
            'normalizeDataValues(): ' + offenders.join(', '));
    });

    it('ISSUE.TRANSFER_SUPPLY specifically stays out (the field this guard was written for)', function () {
        const config = loadConfig();
        assert.ok(!config.NUMBER_FIELDS.includes('TRANSFER_SUPPLY'),
            'TRANSFER_SUPPLY is back in NUMBER_FIELDS: issues.transfer_supply_id will be NULL on ' +
            'every ISSUE again, and rollback will skip the recipient balance refresh');
    });

});

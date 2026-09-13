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
 * XChain Indexer - Database mixin: xbridges
 * 
 * The queries over the xbridges table family in src/sql/. Installed onto Database.prototype by
 * db/index.js, so call sites stay this.db.<method>().
 *
 ********************************************************************/

const path    = require('path');

module.exports = {

    // ── Cross-chain bridge action records (XBRIDGE) ─────────────────────────────

    /**
     * Persist one user-broadcast XBRIDGE action (v0 lock XCHAIN, v1 burn XCHAIN, v3 lock a
     * token, v4 burn a bridged copy) in `xbridges`, valid or refused, the way createSend
     * records a SEND. The system-injected settle legs (v2, v5) never reach here: they are
     * applied from a mirrored bridge_transfers row and recorded in `bridge_settlements`.
     *
     * WHY THE ROW EXISTS. The hub's CrossChainBridgeEngine polls this chain for confirmed
     * locks and burns to sign into a transfer record; `getpendingbridgetransfers` reads
     * this table, so without the row a lock debits the source here and is never signed
     * anywhere. A refused action keeps its row, carrying the verdict in status_id, so the
     * record says what the action asked for.
     *
     * ONE ROW PER ACTION, and the exists-check is keyed on action_index alone: unlike a
     * multi-SEND or multi-DESTROY, an XBRIDGE carries exactly one tick and one destination,
     * so there are no legs to separate. A re-parse of the same block (a rollback and
     * reindex) updates that row in place instead of duplicating it.
     *
     * THE TICK IS DERIVED THE WAY THE HANDLER DERIVES IT, not read off the wire clone: v0
     * and v1 move the GAS tick by construction (the wire carries no TICK field for them),
     * v3 and v4 carry it. Keyed on the version rather than on "TICK is empty" so a v3 whose
     * TICK field is missing records as the tickless action it was, never as an XCHAIN one.
     *
     * @param {Object} data - the handler's raw wire clone plus the fields the lock stamps.
     *                        Reads ACTION_INDEX, FORMAT, TICK (v3/v4), DEST_CHAIN,
     *                        DEST_ADDRESS (v0/v3) or BTC_ADDRESS (v1) or ORIGIN_ADDRESS
     *                        (v4), AMOUNT, DECIMALS, MIN_DEPTH, MEMO, STATUS, BLOCK_INDEX
     * @returns {Promise<void>}
     */
    async createXbridge(data){
        data                = this.normalizeDataValues(data);
        // Numeric-or-NULL, the normalization every other wire-derived integer column gets:
        // an action refused 'invalid: VERSION (unknown)' can carry no version at all, and a
        // NaN bound to a TINYINT throws under STRICT_TRANS_TABLES, which wedges the block
        // loop instead of recording the refusal (the 2026-07-05 DEPOSIT|0|null class).
        let version         = (!this.util.isNull(data['FORMAT']) && this.util.isNumeric(data['FORMAT'])) ? parseInt(data['FORMAT']) : null;
        // v0 and v1 are the GAS tick by construction; v3 and v4 name it on the wire.
        let tick            = (version === 0 || version === 1) ? this.config['GAS'] : data['TICK'];
        // The one destination field this version actually carries. A lock names an address
        // on DEST_COIN, a v1 burn names a BTC address, a v4 burn names an address on the
        // bridged row's origin chain; all three are "where the value lands", so they share
        // one column rather than three mutually-null ones.
        let destination     = (version === 1) ? data['BTC_ADDRESS']
                            : (version === 4) ? data['ORIGIN_ADDRESS']
                            :                   data['DEST_ADDRESS'];
        let tick_id         = await this.createTicker(tick);
        let dest_address_id = await this.createAddress(destination);
        let memo_id         = await this.createMemo(data['MEMO']);
        let status_id       = await this.createStatus(data['STATUS']);
        let action_index    = data['ACTION_INDEX'];
        let dest_chain      = this.util.isNull(data['DEST_CHAIN']) ? null : String(data['DEST_CHAIN']);
        let amount          = data['AMOUNT'];
        // DECIMALS and MIN_DEPTH are stamped by the apply path only, so a refusal that
        // never reached the token read leaves them NULL rather than 0: "not known" and
        // "the issuer set none" are different answers and the hub treats them differently.
        let decimals        = (!this.util.isNull(data['DECIMALS']) && this.util.isNumeric(data['DECIMALS'])) ? parseInt(data['DECIMALS']) : null;
        let min_depth       = (!this.util.isNull(data['MIN_DEPTH']) && this.util.isNumeric(data['MIN_DEPTH'])) ? parseInt(data['MIN_DEPTH']) : null;
        let block_index     = data['BLOCK_INDEX'];
        // Check if record already exists for this action
        let query   = "SELECT action_index FROM xbridges WHERE action_index=? LIMIT 1";
        let results = await this.doQuery(query, [action_index]);
        let args    = [];
        if(results.length > 0){
            // UPDATE record (a re-parse of the same block, after a rollback)
            query = `UPDATE
                        xbridges
                    SET
                        version=?,
                        tick_id=?,
                        dest_chain=?,
                        dest_address_id=?,
                        amount=?,
                        decimals=?,
                        min_depth=?,
                        memo_id=?,
                        status_id=?,
                        block_index=?
                    WHERE
                        action_index=?`;
            args  = [version, tick_id, dest_chain, dest_address_id, amount, decimals, min_depth, memo_id, status_id, block_index, action_index];
        } else {
            // INSERT record
            query = `INSERT INTO xbridges (version, tick_id, dest_chain, dest_address_id, amount, decimals, min_depth, memo_id, status_id, block_index, action_index) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            args  = [version, tick_id, dest_chain, dest_address_id, amount, decimals, min_depth, memo_id, status_id, block_index, action_index];
        }
        await this.doQuery(query, args);
    },

    // The pending-leg SELECT shared by both paths of getPendingBridgeTransfers, so the
    // columns, joins, verdict filter and ordering the RPC handler maps stay one text.
    // `extraWhere` is the path's own predicate (the NOT EXISTS exclusion, or the keyset
    // cursor) and carries no caller input; its placeholders bind ahead of the LIMIT.
    _pendingBridgeTransfersSql(extraWhere){
        return `SELECT
                x.action_index, x.version, x.block_index, x.amount, x.decimals, x.min_depth,
                x.dest_chain, t.tick AS tick, da.address AS dest_address, sa.address AS src_address,
                it.hash AS tx_hash
             FROM
                xbridges x
                INNER JOIN actions            a  ON (a.action_index=x.action_index)
                INNER JOIN index_statuses     s  ON (s.id=x.status_id)
                INNER JOIN index_tickers      t  ON (t.id=x.tick_id)
                INNER JOIN index_addresses    da ON (da.id=x.dest_address_id)
                INNER JOIN index_addresses    sa ON (sa.id=a.source_id)
                INNER JOIN transactions       tx ON (tx.tx_index=a.tx_index)
                INNER JOIN index_transactions it ON (it.id=tx.tx_hash_id)
             WHERE
                s.status='valid' AND x.version IN (0,1,3,4)
                ${extraWhere}
             ORDER BY
                x.action_index ASC
             LIMIT ?`;
    },

};

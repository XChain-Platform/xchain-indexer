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
 * XChain Indexer - Database mixin part: transactions (records action statements)
 *
 * The getActionData summary statements for the record-keeping actions: address
 * preferences, batches, broadcasts, files, links, lists, messages, sleeps and the
 * bare UNKNOWN row.
 * Keyed by action name; src/db/transactions/action_data.js looks a type up here. Every
 * statement is moved unchanged from the branch that held it, and a null entry is an
 * action with no summary statement yet, so getActionData returns null for it.
 *
 ********************************************************************/

module.exports = {

    // ADDRESS action
    ADDRESS: `SELECT
                            a3.action,
                            a1.action_index,
                            a4.address as source,
                            a1.fee_preference,
                            a1.require_memo,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            addresses a1
                            INNER JOIN actions            a2 ON (a2.action_index=a1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a3 ON (a3.id=a2.action_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=a2.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            a1.action_index=?
                        LIMIT 1`,
    // BATCH action
    BATCH: `SELECT
                            a3.action,
                            b1.action_index,
                            a4.address as source,
                            b2.block_index,
                            b2.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            s1.status
                        FROM
                            batches b1
                            INNER JOIN actions            a2 ON (a2.action_index=b1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                            INNER JOIN blocks             b2 ON (b2.block_index=t1.block_index)
                            INNER JOIN index_actions      a3 ON (a3.id=a2.action_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=a2.source_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            b1.action_index=?
                        LIMIT 1`,
    // BROADCAST action
    BROADCAST: `SELECT
                            a2.action,
                            b1.action_index,
                            b1.message,
                            b1.value,
                            b1.fee,
                            b1.broadcast_action_index,
                            a3.address as source,
                            b2.block_index,
                            b2.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            broadcasts b1
                            INNER JOIN actions            a1 ON (a1.action_index=b1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b2 ON (b2.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=b1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            b1.action_index=?
                        LIMIT 1`,
    // FILE action
    FILE: `SELECT
                            a2.action,
                            f1.action_index,
                            f1.name,
                            f1.title,
                            t3.type as type,
                            a3.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            files f1
                            INNER JOIN actions            a1 ON (a1.action_index=f1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=f1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=f1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                        WHERE 
                            f1.action_index=?
                        LIMIT 1`,
    // TODO: Add code to lookup actual file data from transactions and return an `data` item
    // LINK action
    LINK: `SELECT
                            a2.action,
                            l1.action_index,
                            c1.coin as coin1,
                            c2.coin as coin2,
                            l1.coin1_action_index,
                            l1.coin2_action_index,
                            a3.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            links l1
                            INNER JOIN actions            a1 ON (a1.action_index=l1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=l1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=l1.coin1_id)
                            INNER JOIN index_coins        c2 ON (c2.id=l1.coin2_id)
                        WHERE 
                            l1.action_index=?
                        LIMIT 1`,
    // LIST action
    LIST: `SELECT
                            a2.action,
                            l1.action_index,
                            l1.type,
                            l1.edit,
                            l1.list_action_index,
                            a3.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            s1.status
                        FROM
                            lists l1
                            INNER JOIN actions            a1 ON (a1.action_index=l1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            l1.action_index=?
                        LIMIT 1`,
    // MESSAGE action
    MESSAGE: `SELECT
                            a2.action,
                            m1.action_index,
                            a3.address as source,
                            a4.address as destination,
                            m1.encryption_method,
                            m1.encryption_key,
                            m1.encrypted_message,
                            m1.plaintext_message,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            s1.status
                        FROM
                            messages m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=m1.destination_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            m1.action_index=?
                        LIMIT 1`,
    // SLEEP action
    SLEEP: `SELECT
                            a2.action,
                            s1.action_index,
                            s1.type,
                            a3.address as source,
                            t3.tick,
                            s1.resume_block,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s2.status
                        FROM
                            sleeps s1
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                            INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT JOIN index_tickers       t3 ON (t3.id=s1.tick_id)
                        WHERE 
                            s1.action_index=?
                        LIMIT 1`,
    // UNKNOWN
    UNKNOWN: `SELECT
                            a2.action,
                            a1.action_index,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index
                        FROM
                            actions                       a1
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        WHERE 
                            a1.action_index=?
                        LIMIT 1`,

};

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
 * XChain Indexer - Database mixin part: transactions (trades action statements)
 *
 * The getActionData summary statements for the trading actions: orders and swaps
 * with their cancels, edits and matches, and the dispenser pair that has none yet.
 * Keyed by action name; src/db/transactions/action_data.js looks a type up here. Every
 * statement is moved unchanged from the branch that held it, and a null entry is an
 * action with no summary statement yet, so getActionData returns null for it.
 *
 ********************************************************************/

module.exports = {

    // DISPENSER action
    // TODO
    DISPENSER: null,
    // DISPENSE action
    // TODO
    DISPENSE: null,
    // ORDER action
    ORDER: `SELECT
                            a2.action,
                            o1.action_index,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            o1.give_amount,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            o1.get_amount,
                            a3.address as source,
                            a4.address as get_address,
                            o1.expiration,
                            o1.allow_list,
                            o1.block_list,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s1.status
                        FROM
                            orders o1
                            INNER JOIN actions            a1 ON (a1.action_index=o1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=o1.get_address_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=o1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=o1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=o1.give_coin_id)
                            INNER JOIN index_coins        c2 ON (c2.id=o1.get_coin_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=o1.give_tick_id)
                            INNER JOIN index_tickers      t4 ON (t4.id=o1.get_tick_id)
                        WHERE 
                            o1.action_index=?
                        LIMIT 1`,
    // ORDER_CANCEL action
    ORDER_CANCEL: `SELECT
                        a2.action,
                        o1.action_index,
                        o1.order_action_index,
                        a3.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s1.status
                    FROM
                        order_cancels o1
                        INNER JOIN actions            a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        LEFT  JOIN index_memos        m2 ON (m2.id=o1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=o1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        o1.action_index=?
                    LIMIT 1`,
    // ORDER_EDIT action
    ORDER_EDIT: `SELECT
                        a2.action,
                        o1.action_index,
                        o1.order_action_index,
                        a3.address as source,
                        o1.expiration,
                        o1.allow_list,
                        o1.block_list,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s1.status
                    FROM
                        order_edits o1
                        INNER JOIN actions            a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        LEFT  JOIN index_memos        m2 ON (m2.id=o1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=o1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        o1.action_index=?
                    LIMIT 1`,
    // ORDER_MATCH action
    ORDER_MATCH: `SELECT
                            a2.action,
                            m1.action_index,
                            c1.coin as give_coin,
                            m1.give_action_index,
                            c2.coin as get_coin,
                            m1.get_action_index,
                            b1.block_index,
                            b1.block_time as timestamp,
                            s1.status
                        FROM
                            order_matches m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=m1.give_coin_id)
                            INNER JOIN index_coins        c2 ON (c2.id=m1.get_coin_id)
                        WHERE 
                            m1.action_index=?
                        LIMIT 1`,
    // SWAP action
    SWAP: `SELECT
                            a2.action,
                            s1.action_index,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            s1.give_amount,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            s1.get_amount,
                            a3.address as source,
                            a4.address as get_address,
                            s1.expiration,
                            s1.allow_list,
                            s1.block_list,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s2.status
                        FROM
                            swaps s1
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=s1.get_address_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                            INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=s1.give_coin_id)
                            INNER JOIN index_coins        c2 ON (c2.id=s1.get_coin_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=s1.give_tick_id)
                            INNER JOIN index_tickers      t4 ON (t4.id=s1.get_tick_id)
                        WHERE 
                            s1.action_index=?
                        LIMIT 1`,
    // SWAP_CANCEL action
    SWAP_CANCEL: `SELECT
                        a2.action,
                        s1.action_index,
                        s1.swap_action_index,
                        a3.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s2.status
                    FROM
                        swap_cancels s1
                        INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        s1.action_index=?
                    LIMIT 1`,
    // SWAP_EDIT action
    SWAP_EDIT: `SELECT
                        a2.action,
                        s1.action_index,
                        s1.swap_action_index,
                        a3.address as source,
                        s1.expiration,
                        s1.allow_list,
                        s1.block_list,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s2.status
                    FROM
                        swap_edits s1
                        INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        s1.action_index=?
                    LIMIT 1`,
    // SWAP_MATCH action
    SWAP_MATCH: `SELECT
                            a2.action,
                            m1.action_index,
                            c1.coin as give_coin,
                            m1.give_action_index,
                            c2.coin as get_coin,
                            m1.get_action_index,
                            b1.block_index,
                            b1.block_time as timestamp,
                            s1.status
                        FROM
                            swap_matches m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=m1.give_coin_id)
                            INNER JOIN index_coins        c2 ON (c2.id=m1.get_coin_id)
                        WHERE 
                            m1.action_index=?
                        LIMIT 1`,

};

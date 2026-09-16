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
 * XChain Indexer - Database class part: transactions and queries
 *
 * Transaction begin, rollback and commit, and the doQuery and doQueryStrict entry points
 * every read and write goes through.
 *
 * A part of the Database class body: db/index.js installs it onto Database.prototype,
 * non-enumerable and in the order the class declared it, so call sites stay
 * this.db.<method>().
 *
 ********************************************************************/

// Strict, as the class body these methods came from was.
'use strict';

const { getLogger } = require('../../observability/index.js');

module.exports = {

    // Handle beginning a SQL transaction.
    // `opts.acquireTimeoutMs` time-boxes the wait for the transaction mutex and
    // throws TX_LOCK_BUSY instead of queueing; unset (every block-loop and reorg caller)
    // keeps the unbounded wait.
    async beginTransaction(opts){
        await this.acquireTxLock(opts && opts.acquireTimeoutMs);
        if(this.transactionConnection != null)
            await this.releaseConnection();
        try {
            this.transactionConnection = await this.getConnection();
            await this.transactionConnection.beginTransaction();
            // Fresh epoch for this transaction (M-16). The block loop reads it via
            // currentTxEpoch() and fences the block promise to it.
            this._txEpoch++;
        } catch(e){
            if(this.transactionConnection != null){
                try { await this.transactionConnection.release(); } catch(_){}
                this.transactionConnection = null;
            }
            this.releaseTxLock();
            this.util.throwError('beginTransaction error=' + e);
        }
    },

    // Handle rolling back a SQL transaction and releasing the connection
    async rollbackTransaction(){
        if(this.transactionConnection != null){
            getLogger().info("rolling back");
            try {
                await this.transactionConnection.rollback();
            } finally {
                await this.transactionConnection.release();
                this.transactionConnection = null;
                // Fence any zombie of the block that just rolled back (M-16): bumping the
                // epoch here closes even the window before the next block's beginTransaction,
                // so a post-rollback zombie write cannot land as a stray auto-committed row.
                this._txEpoch++;
                // The abort just un-assigned every dense index id this transaction handed
                // out, so the id -> name memos it filled are now lies about ids the next
                // caller will be given. In the finally, beside the epoch bump, for
                // the same reason: a throw out of rollback() must not be able to skip it.
                this.clearSmtNameCaches();
                this.releaseTxLock();
            }
        }
    },

    // Handle commiting a SQL transaction and releasing the connection
    async commitTransaction(){
        if(this.transactionConnection != null){
            try {
                await this.transactionConnection.commit();
                await this.transactionConnection.release();
                this.transactionConnection = null;
                // Fence any zombie of the block that just committed (M-16).
                this._txEpoch++;
                this.releaseTxLock();
                return true;
            } catch (e){
                getLogger().error('Error committing transaction:', e)
                try {
                    await this.transactionConnection.rollback();
                } finally {
                    await this.transactionConnection.release();
                    this.transactionConnection = null;
                    this._txEpoch++;
                    // A failed commit aborts, so its id assignments are gone too.
                    this.clearSmtNameCaches();
                    this.releaseTxLock();
                }
                this.util.throwError('commitTransaction error=' + e);
            }
        }
        return false;
    },

    // Handle running a query and returning the results
    async doQuery(query, args){
        this.assertTxNotFenced();
        let results = [];
        if(!this.util.isNull(query)){
            // Normalize args: convert any boxed primitives (e.g. mathjs BigNumber) to plain values.
            // Skip Buffers - the mariadb driver inserts them as binary into BLOB columns; calling
            // .toString() on them would UTF-8-decode the bytes and replace invalid sequences with
            // U+FFFD, corrupting binary payloads (e.g. FILE raw_data ciphertext).
            if(Array.isArray(args)){
                for(let i = 0; i < args.length; i++){
                    if(args[i] !== null && args[i] !== undefined && typeof args[i] === 'object' && !Buffer.isBuffer(args[i]))
                        args[i] = args[i].toString();
                }
            }
            let tx = this.transactionConnection != null;
            let db = await this.getConnection();
            try {
                results = await db.query(query, args);
            } catch (error){
                this.util.logError('Error running database query :', error);
                // Inside a transaction, re-throw so the block-level catch triggers a rollback
                // This prevents silent data loss from failed writes within an ACID transaction
                if(tx)
                    throw error;
            }
            // Release the connection if we are not in the middle of a ACID transaction
            if(!tx)
                await db.release();
        }
        return results;
    },

    // Like doQuery, but a query error ALWAYS throws, transactional or not.
    // For consensus-input reads: doQuery collapses a non-transactional query
    // error into [], indistinguishable from a genuinely empty result, so a
    // transient DB fault becomes "no data" on this node only and can fork the
    // ledger (M-17: the hub-DB price read). Callers inside block processing
    // let the throw roll back and retry the block.
    async doQueryStrict(query, args){
        this.assertTxNotFenced();
        let results = [];
        if(!this.util.isNull(query)){
            if(Array.isArray(args)){
                for(let i = 0; i < args.length; i++){
                    if(args[i] !== null && args[i] !== undefined && typeof args[i] === 'object' && !Buffer.isBuffer(args[i]))
                        args[i] = args[i].toString();
                }
            }
            let tx = this.transactionConnection != null;
            let db = await this.getConnection();
            try {
                results = await db.query(query, args);
            } catch (error){
                this.util.logError('Error running database query :', error);
                throw error;
            } finally {
                if(!tx)
                    await db.release();
            }
        }
        return results;
    },

};

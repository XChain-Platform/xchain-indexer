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
 * XChain Indexer - Database class part: connections and fences
 *
 * Pool connections behind the circuit breaker, the transaction mutex, and the M-16 epoch
 * fence with the price-barrier backstop that rides on it.
 *
 * A part of the Database class body: db/index.js installs it onto Database.prototype,
 * non-enumerable and in the order the class declared it, so call sites stay
 * this.db.<method>().
 *
 ********************************************************************/

// Strict, as the class body these methods came from was.
'use strict';

const { getLogger } = require('../../observability/index.js');
// Module-level state and pure helpers that the split keeps in one place, so the class
// and every mixin read the same instance of each.
const { txEpochStore } = require('../shared.js');

module.exports = {

    /* 
     * Common database connection functions (connect / rollback / commit / doQuery)
     */

    // Handle getting a database Connection (with exponential backoff + jitter)
    async getConnection(){
        if(this.transactionConnection)
            return this.transactionConnection;
        // Circuit breaker: reject immediately if open
        if(this.circuitState === 'open'){
            if(Date.now() < this.circuitOpenUntil)
                this.util.throwError('Circuit breaker open - database connections rejected until cooldown expires');
            // Cooldown expired, transition to half-open
            this.circuitState = 'half-open';
            getLogger().info('Circuit breaker half-open - attempting reconnection');
        }
        var connection    = null;
        var attempts      = 0;
        var maxAttempts   = 30;
        var baseDelay     = 500;   // 500ms initial delay
        var maxDelay      = 15000; // 15s max delay
        while(connection == null){
            try {
                connection = await this.pool.getConnection();
                // Reset circuit breaker on success
                if(this.circuitState === 'half-open'){
                    this.circuitState = 'closed';
                    this.circuitFailures = 0;
                    getLogger().info('Circuit breaker closed - database connection restored');
                }
                this.circuitFailures = 0;
            } catch (e){
                attempts++;
                this.circuitFailures = (this.circuitFailures || 0) + 1;
                // Circuit breaker: open after consecutive failures
                if(this.circuitFailures >= this.circuitThreshold){
                    this.circuitState = 'open';
                    this.circuitOpenUntil = Date.now() + this.circuitCooldown;
                    this.util.throwError('Circuit breaker opened after ' + this.circuitFailures + ' consecutive failures - cooling down for ' + (this.circuitCooldown / 1000) + 's');
                }
                if(attempts >= maxAttempts)
                    this.util.throwError('Could not connect to MariaDB after ' + maxAttempts + ' attempts. Giving up.');
                // Exponential backoff with jitter: delay = min(baseDelay * 2^attempt, maxDelay) + random jitter
                let delay = Math.min(baseDelay * Math.pow(2, attempts - 1), maxDelay);
                let jitter = Math.floor(Math.random() * delay * 0.3); // up to 30% jitter
                let totalDelay = delay + jitter;
                getLogger().error('MariaDB connection attempt ' + attempts + '/' + maxAttempts + ' failed. Retrying in ' + totalDelay + 'ms...', e)
                connection = null;
                await this.util.sleep(totalDelay);
            }
        }
        return connection;
    },

    // Handle releasing a connection and freeing it up for additional queries
    async releaseConnection(){
        if(this.transactionConnection != null){
            await this.transactionConnection.release();
            this.transactionConnection = null;
        }  
    },

    // Drain the connection pool so a process holding this Database can exit. The
    // long-running services never call it (they hold their pool for their lifetime),
    // but every bin/ harness ends with `if(db.close) await db.close()` and there was
    // no such method, so the guard silently did nothing and the pool's idle sockets
    // kept the event loop alive: the tool printed its results and then hung until it
    // was killed, which reads as a slow benchmark rather than as a finished one.
    async close(){
        await this.releaseConnection();
        if(this.pool){
            try { await this.pool.end(); } catch(_){}
            this.pool = null;
        }
    },

    // Acquire the transaction mutex (this._txLock). Resolves once the lock is held.
    // Non-reentrant: a single flow must not call this twice before releasing.
    //
    // `timeoutMs` bounds the WAIT. Unset keeps the block loop's unbounded queue
    // which is the only correct behaviour for a caller that must eventually run. A public
    // read-only caller passes a budget instead, because queueing behind a whole block's
    // processing is what turned a fee quote into a 25-40s hang and then an explorer 502:
    // the quote's own time box only ever covered the dry-run, never the wait in front of it.
    // Rejects with code TX_LOCK_BUSY, before any connection work, so the caller can answer
    // "busy, retry" in milliseconds.
    acquireTxLock(timeoutMs){
        if(!this._txLock.locked){
            this._txLock.locked = true;
            return Promise.resolve();
        }
        let waiter = { settled: false, grant: null };
        if(!(Number(timeoutMs) > 0)){
            return new Promise(resolve => {
                waiter.grant = resolve;
                this._txLock.queue.push(waiter);
            });
        }
        return new Promise((resolve, reject) => {
            let timer = setTimeout(() => {
                if(waiter.settled) return;
                // Stays in the queue but marked settled; releaseTxLock skips it. Splicing
                // here would be O(n) on every give-up for no benefit.
                waiter.settled = true;
                let e = new Error('transaction lock busy: waited ' + Number(timeoutMs) +
                    'ms for the database transaction mutex (block processing holds it)');
                e.code = 'TX_LOCK_BUSY';
                reject(e);
            }, Number(timeoutMs));
            // Never let a queued waiter's timer alone hold the process open.
            if(timer.unref) timer.unref();
            waiter.grant = () => { clearTimeout(timer); resolve(); };
            this._txLock.queue.push(waiter);
        });
    },

    // Release the transaction mutex, handing it to the next LIVE waiter. A waiter that
    // already timed out is skipped rather than granted: handing the lock to a
    // caller that has given up would strand it held with nothing left to release it, which
    // would wedge block processing permanently - a far worse failure than the slow quote
    // the budget exists to bound.
    releaseTxLock(){
        while(this._txLock.queue.length > 0){
            let next = this._txLock.queue.shift();
            if(next.settled) continue;
            next.settled = true;
            next.grant();
            return;
        }
        this._txLock.locked = false;
    },

    // The DB transaction epoch active right now (M-16). The block loop reads this
    // immediately after beginTransaction and runs the block promise under it (runInTxEpoch)
    // so every write it issues is fenced to this epoch.
    currentTxEpoch(){
        return this._txEpoch;
    },

    // Run fn with `epoch` installed as the watchdog-fence context for every DB call fn makes
    // (transitively, across awaits). Returns fn's return value (the block-processing promise).
    // Used by the BLOCK LOOP; behavior on the non-timeout path is unchanged because the
    // installed epoch always equals the current _txEpoch until the transaction is torn down.
    // The context records WHICH Database instance owns the guarded transaction: the indexer
    // process holds several instances of this class (indexer DB, decoder DB, hub-DB mirror),
    // and the fence must only guard the owner's shared transactionConnection. A read through
    // a sibling instance inside the same async context (e.g. a hub-mirror price read during
    // fee validation) draws from that instance's own pool and can never land in the guarded
    // transaction, so it must not be fenced (its epoch counter never advances, so comparing
    // across instances fences every such read; caught live on regtest 2026-07-08).
    // `consensus: true` marks this context as real block processing, which is what
    // assertPriceBarrierNotSkipped keys on; see runInDryRunEpoch below for why the flag
    // exists and why THIS is the defaulted side.
    runInTxEpoch(epoch, fn){
        return txEpochStore.run({ owner: this, epoch: epoch, consensus: true }, fn);
    },

    // Same M-16 fence, no consensus authority. The fee-quote dry run needs the
    // zombie-write protection above - it holds the shared transaction and can be abandoned by
    // its watchdog exactly as a block can - but it is NOT block processing and it commits
    // nothing. assertPriceBarrierNotSkipped used "a txEpochStore context exists" as its proof
    // that a caller is the block loop, and this call site made that proof false: a public
    // /feequote whose dry run read the price mirror during a barrier-skipped block answered
    // `handler threw: ... PRICE_BARRIER_DEFERRED` and, worse, set priceBarrierForceBlock, so an
    // unauthenticated read wrote block-loop state. Splitting the two kinds is the whole fix.
    // The DEFAULT is deliberately on runInTxEpoch: an unlabelled future caller is then treated
    // as consensus and trips the barrier as before, which is over-firing rather than silently
    // escaping a consensus guard. Opting OUT has to be a visible act, and this is it.
    runInDryRunEpoch(epoch, fn){
        return txEpochStore.run({ owner: this, epoch: epoch, consensus: false }, fn);
    },

    // Watchdog fence (M-16). Reject a write whose issuing epoch no longer matches the current
    // transaction epoch ON THE INSTANCE THAT OWNS THE GUARDED TRANSACTION. Only block-loop
    // code runs inside a txEpochStore context, so an owner-match with a stale epoch means this
    // call is an abandoned (timed-out) block's zombie continuation trying to write after its
    // transaction was rolled back and a later block's transaction took over the shared
    // connection. No stored context = a non-block-loop caller (federation RPC read, health
    // check); an owner mismatch = a sibling Database instance's pool read inside the block's
    // async context; neither is fenced. This can only ADD a throw on the already-broken
    // timeout path; it never suppresses a legitimate write, so the non-timeout path is
    // byte-identical.
    assertTxNotFenced(){
        const ctx = txEpochStore.getStore();
        if(ctx !== undefined && ctx.owner === this && ctx.epoch !== this._txEpoch)
            this.util.throwError('transaction fenced (M-16): write from epoch ' + ctx.epoch +
                ' after teardown (current epoch ' + this._txEpoch + '); zombie write rejected');
    },

    // fail-closed backstop for the action-scoped price barrier. The block loop skips
    // the price/oracle mirror barriers when priceReadPredicate proved the block carries no
    // transaction-borne price reader. That predicate cannot see the end-of-block passes:
    // processCrossChainCalls injects XEXEC actions and runs XCALL callback isolates from
    // hub-mirror state on blocks with no transaction at all, and the VM exposes
    // oracle.getPrice to contract code. Rather than predict those (their due sets are
    // queried inside the block transaction and the mirror keeps syncing concurrently, so any
    // prediction is racy), every price-mirror read asserts here: if this block skipped the
    // barrier and something reads anyway, fail the block instead of reading an uncovered
    // mirror. The block rolls back, priceBarrierForceBlock makes the retry take the barrier,
    // and it commits on the second attempt. Same machinery the watchdog path already uses.
    //
    // Scoped to block processing by the txEpochStore context's `consensus` flag, which only
    // runInTxEpoch sets and which propagates across awaits into sibling Database instances (the
    // hub mirror reads run on this exact path). Two ways out, and BOTH are needed: no stored
    // context = an API / healthcheck read, and a stored context with consensus false = the
    // fee-quote dry run, which installs a context of its own for the M-16 fence.
    // Either is free to read whatever the mirror currently holds, because neither commits
    // anything - only a block can carry an uncovered mirror read into consensus state. Testing
    // for the flag rather than for the context's mere existence is what actually stops a
    // concurrent api.js fee quote from tripping a consensus guard; testing for existence alone
    // did not, and cost three sweep drives and a wrong "fee price unavailable" on screen.
    // The deferral is thrown as a typed Error carrying PRICE_BARRIER_DEFERRED, because the
    // readers this backstop fires on sit INSIDE action catches that swallow deterministic
    // contract failures (xexec's execution catch, the XCALL/ATTEST callback catches). A bare
    // string carries no code and no errno, so faultGuard read it as a contract outcome and the
    // block committed a validator-local 'error' verdict instead of retrying with the barrier
    // (every injected XEXEC on a transaction-less block recorded result_status='error'
    // while healthy peers recorded 'ok'). The code is what makes rethrowIfInfraFault propagate.
    assertPriceBarrierNotSkipped(site){
        const ctx = txEpochStore.getStore();
        if(ctx === undefined || ctx.consensus !== true) return;
        const ix = this.indexer;
        if(!ix || !ix.priceBarrierSkipped) return;
        // Escalate THIS block: the retry must not skip again, or it loops forever.
        ix.priceBarrierForceBlock = ix.priceBarrierBlock;
        const err = new Error('price barrier skipped but ' + site + ' read the price mirror at block ' +
            ix.priceBarrierBlock + '; deferring the block so it re-runs with the barrier enforced');
        err.code = 'PRICE_BARRIER_DEFERRED';
        this.util.throwError(err);
    },

};

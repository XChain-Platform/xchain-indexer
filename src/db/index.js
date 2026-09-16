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
 * XChain Indexer - Database Class
 * 
 * This file handles connecting to databases and running SQL queries
 *
 ********************************************************************/

// Runtime floor, asserted above the require it protects. The pinned mariadb 3.5.x line is
// ESM-only ("type": "module"), and require() loads ESM without a flag only from Node 22.12.0;
// below that the next line throws a bare ERR_REQUIRE_ESM that names neither the Node version
// nor the reason. engines.node cannot enforce this (npm only warns, and nothing in the tree
// sets engine-strict), and .nvmrc says only "22", so the check lives here, where the failure
// actually happens. Same guard, same wording, as xchain-hub/src/db/index.js.
const [NODE_MAJOR, NODE_MINOR] = String(process.versions.node).split('.').map(Number);
if (NODE_MAJOR < 22 || (NODE_MAJOR === 22 && NODE_MINOR < 12)) {
    throw new Error('xchain-indexer requires Node >= 22.12.0 (running ' + process.versions.node +
        '): the pinned mariadb 3.5.x driver is ESM-only and require() can load ESM without ' +
        'a flag only from Node 22.12. Upgrade the runtime (see .nvmrc), or start Node with ' +
        '--experimental-require-module.');
}

// Load required libraries
const mariadb = require('mariadb');
// Module-level state and pure helpers that the split keeps in one place, so the class
// and every mixin read the same instance of each.
const { requireStakeWeight } = require('./shared.js');

// The state the constructor builds, one helper per concern (database/instance_state.js).
const { connectionParams, connectionPoolParams, initIndexIdState, initReadMemos,
        initTransactionState } = require('./database/instance_state.js');

class Database {

    constructor(host, port, dbName, user, pass, indexer) {
        this.config = indexer.config

        this.util   = indexer.util;

        // Reference back to the parent indexer (so dependent code can access hubDb, etc.)
        this.indexer = indexer;

        // Database connection information
        this.host   = host;
        this.port   = port;
        this.dbName = dbName;
        this.user   = user;
        this.pass   = pass;


        // Database connection parameters
        this.connectionParams = connectionParams(this);

        // Database pool connection parameters
        this.connectionPoolParams = connectionPoolParams(this);

        // Setup pool of connections
        this.pool = mariadb.createPool(this.connectionPoolParams);
        this.transactionConnection = null;

        // The rest of the instance state, in the order the fields were always assigned:
        // the index-id guards, the read memos, then the transaction and circuit state.
        initIndexIdState(this);
        initReadMemos(this);
        initTransactionState(this);
    }

}

// Published before the mixins load, so a mixin that reads the class for its statics
// resolves to the class itself rather than to a half-built export.
module.exports = Database

// Startup DB-connect resilience (#3168). Cap transient connect retries so a boot never
// hangs silently forever; a non-retryable auth/grant error fails fast so pm2 surfaces it
// (a crash-loop is a visible signal, an unbounded silent hang is not).
Database.DB_CONNECT_MAX_ATTEMPTS = 12; // ~60s of 5s backoff before giving up on a transient fault
Database._isNonRetryableDbError = function(e){
    if(!e) return false;
    // MariaDB/MySQL auth + grant errnos: 1045 access denied (bad password),
    // 1044 access denied to database, 1698 auth-plugin denied. These never self-heal.
    let errno = e.errno;
    if(errno === 1045 || errno === 1044 || errno === 1698) return true;
    let code = String(e.code || '');
    return code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR';
};

// The migration statics, in the order the class has always published them: the runner-side
// data tables keyed by filename, then the rename, backdating and deploy-precondition registry.
// Required only here, after the export above, because the registry reads the class back.
Object.assign(Database, require('./database/migration_tables.js'), require('./database/migration_registry.js'));

// Exposed for the unit suite (and the sync-twin drift check): the weightless-row
// guard is consensus-relevant, so it is tested directly, not only through a query.
Database.requireStakeWeight = requireStakeWeight;

// What `markets.tick1_id` / `tick2_id` hold for a side that is the native coin
// rather than a token. NOT NULL, because MariaDB treats NULL as distinct inside a
// UNIQUE index: a NULL-keyed side slips past uq_markets_pair, so the pair loses the
// one-row-per-market guarantee every other pair has. index_tickers ids start at 1,
// so 0 can never collide with a real ticker. Which coin the side actually is comes
// from the row's coin1_id / coin2_id.
Database.MARKET_NATIVE_TICK_ID = 0;

// Decimal precision of a native-coin market side. Tokens carry their own precision
// in `tokens.decimals`; the coin has no such row, and every chain the indexer follows
// denominates in 1e-8 units. Only the 24h volume accumulator reads it, so a coin that
// ever differed would misprint a display total, not a ledger amount.
Database.MARKET_NATIVE_DECIMALS = 8;

// A market side's tick id as `markets` stores it. `orders` and `order_matches`
// carry NULL on a tickerless side; this is the one place that translation happens.
Database.marketTickId = function(tick_id){
    if(tick_id === null || tick_id === undefined || tick_id === '')
        return Database.MARKET_NATIVE_TICK_ID;
    return Number(tick_id);
};

// Installed NON-ENUMERABLE, which is what the class body they came from produced: the
// suites stub them through sinon.stub(Database.prototype, name), and an enumerable
// prototype would also put every query into for-in and Object.keys over an instance.
function installOnPrototype(methods){
    const descriptors = Object.getOwnPropertyDescriptors(methods);
    for(const key of Reflect.ownKeys(descriptors)) descriptors[key].enumerable = false;
    Object.defineProperties(Database.prototype, descriptors);
}

// The class body's own methods, split by concern into database/ and installed first, in the
// order the class declared them: the prototype keeps its name order, and a mixin installed
// below would still win a name it shared with the class body (none does).
installOnPrototype(require('./database/schema_setup.js'));
installOnPrototype(require('./database/migration_runner.js'));
installOnPrototype(require('./database/startup_assertions.js'));
installOnPrototype(require('./database/migration_scan.js'));
installOnPrototype(require('./database/schema_drift.js'));
installOnPrototype(require('./database/index_reconcile.js'));
installOnPrototype(require('./database/sql_text.js'));
installOnPrototype(require('./database/connections.js'));
installOnPrototype(require('./database/transaction_queries.js'));
installOnPrototype(require('./database/normalize.js'));
installOnPrototype(require('./database/block_reads.js'));
installOnPrototype(require('./database/ledger_checks.js'));
installOnPrototype(require('./database/stake_weights.js'));
installOnPrototype(require('./database/mirror_reads.js'));
installOnPrototype(require('./database/controllers_vm.js'));

// One mixin per DDL family in src/sql/; index.js keeps the constructor and the statics, and
// database/ holds the pool, the migrations, the transaction plumbing and the other class-body
// methods. The set is a list rather than a directory scan so a file dropped into db/ cannot
// silently add prototype methods.
const MIXIN_FILES = [
    './actions.js',
    './addresses/index.js',
    './airdrops/index.js',
    './anchors/index.js',
    './attests/index.js',
    './balances/index.js',
    './batches/index.js',
    './bets/index.js',
    './blocks/index.js',
    './bridge_settlements/index.js',
    './bridges/index.js',
    './broadcasts/index.js',
    './callbacks/index.js',
    './capabilities/index.js',
    './coinpays/index.js',
    './contracts/index.js',
    './credits/index.js',
    './cross_chain/index.js',
    './delegations/index.js',
    './deploys/index.js',
    './deposits/index.js',
    './destroys/index.js',
    './dispensers/index.js',
    './dispenses/index.js',
    './dividends/index.js',
    './escrow_journal/index.js',
    './escrows/index.js',
    './events/index.js',
    './fees/index.js',
    './files/index.js',
    './full_node_verifications/index.js',
    './hub_pushes/index.js',
    './index_tables/index.js',
    './issues/index.js',
    './links/index.js',
    './lists/index.js',
    './mappings/index.js',
    './markets/index.js',
    './messages/index.js',
    './mints/index.js',
    './misc/index.js',
    './orders/index.js',
    './polls/index.js',
    './prices/index.js',
    './pubkeys/index.js',
    './rewards/index.js',
    './rollcalls/index.js',
    './sends/index.js',
    './slashes/index.js',
    './sleeps/index.js',
    './stakes.js',
    './state_tree/index.js',
    './swaps/index.js',
    './sweeps/index.js',
    './tokens/index.js',
    './transactions/index.js',
    './votes/index.js',
    './withdrawals/index.js',
    './xbridges/index.js',
    './xcalls/index.js',
];

// The require takes a computed path because the list above is the declaration.
for(const file of MIXIN_FILES) installOnPrototype(require(file));

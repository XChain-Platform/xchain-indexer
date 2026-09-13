/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
 * XChain Indexer - Genesis Ledger Bootstrap
 *
 * Injects Counterparty/Dogeparty asset-NAME ownership into the XChain ledger at
 * a configured genesis block. Each name in the bundled manifest (tick,owner CSV)
 * is issued by the GAS address and ends up owned by its real owner, so every
 * reserved name has a genuine GAS-issued chain of custody.
 *
 * XChain gates subtoken creation on owning the parent (issue.js), so GAS must own
 * a parent while its children are created. We split the manifest into ancestors
 * (names that are the parent-prefix of another name) and leaves (no descendants):
 *   - Leaf: a single ISSUE that both creates the tick and TRANSFERs it to its owner.
 *     The parent gate reads the parent's owner BEFORE the in-action transfer, so the
 *     create+transfer is accepted as long as GAS still owns the parent at that point.
 *   - Ancestor: created owned by GAS in the create pass (transfer deferred), then
 *     handed to its owner in a cleanup pass over ancestors only, in REVERSE order
 *     (child-ancestor before parent-ancestor) so a parent stays GAS-owned until its
 *     descendants are placed. GAS-owned ancestors need no transfer.
 * This collapses the historical "issue every name twice" to one action per leaf
 * (the vast majority) while still landing divergent-owner subassets correctly.
 * Name ownership only; no balances (the airdrop is separate).
 *
 * Determinism is consensus-critical: the same manifest, applied in the same order
 * with deterministic synthetic tx hashes, produces identical ledger/state hashes
 * on every node. The manifest is pinned by sha256 (GENESIS_LEDGER_HASH); a
 * mismatch halts the node.
 *
 ********************************************************************/

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// Every lock a bridged row carries (xchain-token-bridge.md section 6). The copy is keyless
// by design, so these are set once at creation and can never be changed afterwards: nobody
// can mint it, rename it, sleep it or attach a callback to it. LOCK_MAX_SUPPLY is NOT in the
// set and must not be added: issue.js refuses a lock with no positive cap, and a bridged row
// is deliberately uncapped.
const BRIDGE_ROW_LOCKS = {
    LOCK_MINT:        '1',
    LOCK_MINT_SUPPLY: '1',
    LOCK_MAX_MINT:    '1',
    LOCK_DESCRIPTION: '1',
    LOCK_SLEEP:       '1',
    LOCK_CALLBACK:    '1'
};

class Genesis {

    constructor(actions, indexerDb, config, util){
        this.actions   = actions;
        this.indexerDb = indexerDb;
        this.config    = config;
        this.util      = util;
    }

    // Called once per block from the indexer loop. No-op unless this is the
    // configured genesis block for this chain (GENESIS_BLOCK = 0 disables it).
    async inject(blockToParse, blockTime){
        let genesisBlock = this.config['GENESIS_BLOCK'];
        if(!genesisBlock || Number(blockToParse) !== Number(genesisBlock))
            return;

        let gas  = this.config['ADDRESS']['GAS'];

        // Fast path: if a precomputed state dump is present, bulk-import it instead of
        // re-deriving the ledger through the pipeline. The importer verifies the artifact
        // against GENESIS_DUMP_HASH and re-checks the recomputed block hashes (see
        // genesisDump.js), so the imported state is provably the canonical genesis state.
        let dumpFile = this.config['GENESIS_DUMP_PATH'];
        if(dumpFile && fs.existsSync(dumpFile)){
            console.log('GENESIS: importing precomputed dump for ' + this.config['COIN'] + ' at block ' + blockToParse + ' from ' + dumpFile);
            if(this.util.isNull(this.config['GENESIS_DUMP_HASH']))
                console.warn('GENESIS: GENESIS_DUMP_HASH is not pinned; importing on the dump-recorded block hashes only (no content-hash anchor).');
            let GenesisDump = require('./genesisDump');
            let res = await (new GenesisDump(this.indexerDb, this.util, this.config)).read(dumpFile);
            console.log('GENESIS: imported ' + res.rowsImported + ' rows (block hashes verified)');
            return;
        }

        let file = this.config['GENESIS_LEDGER_PATH'];
        console.log('GENESIS: bootstrapping ' + this.config['COIN'] + ' name ownership at block ' + blockToParse + ' from ' + file);

        // Consensus checkpoint: verify the bundled manifest against the pinned hash.
        this._verifyManifest(file);

        // Load + pre-flight rows (dedupe, tick sanity, parent-before-child order).
        let rows = this._loadRows(file);

        // Enable the genesis-only intern cache for the duration of injection. The pipeline
        // re-resolves the same ticks and the constant GAS source many times per action; the
        // cache collapses those getTickerId/getAddressId SELECTs to one DB hit each. Safe
        // here only because genesis is one atomic block (ids assigned, never deleted), and
        // cleared in the finally so the block's later real transactions run uncached.
        this.indexerDb._internCache = { addr: new Map(), tick: new Map(), tx: new Map() };
        try {

        // Ancestor set: every strict prefix-parent that appears among the loaded ticks.
        // A tick is an ancestor if some OTHER tick has it as a "a", "a.b", ... prefix.
        // Ancestors must stay GAS-owned while their descendants are placed; leaves do not.
        let ancestors = this._ancestorSet(rows);

        // Gas token: inject XCHAIN as the first genesis action (BTC mainnet only). Unlike the
        // CP/DP name reservations, it carries real token parameters and is the canonical
        // creation of the platform gas token. ISSUE of XCHAIN is GAS-only (issue.js) and
        // BTC-only, so this is the single place it is ever created on a live chain.
        if(this.config['COIN'] === 'BTC' && this.config['NETWORK'] === 'mainnet')
            await this._injectGasToken(gas, blockToParse, blockTime);

        // Create pass: GAS issues every tick once, in file (parent-before-child) order so
        // GAS owns each parent when its children are created (the parent gate passes).
        // A leaf folds its TRANSFER into this single action (the gate reads the parent's
        // owner before the transfer is applied, and transferring a leaf never disturbs a
        // parent). An ancestor is created owned by GAS and its transfer is deferred below.
        for(let r of rows){
            let transfer = (!ancestors.has(r.tick) && r.owner !== gas) ? r.owner : null;
            await this._issue(gas, r.tick, transfer, blockToParse, blockTime, 1);
        }

        // Cleanup pass: GAS transfers each ANCESTOR to its real owner, in REVERSE file
        // order (child-ancestor before parent-ancestor). A subtoken transfer is gated on
        // the SOURCE still owning the parent (issue.js parent gate); transferring a parent
        // to its owner first would strand a descendant ancestor whose transfer still needs
        // GAS to own that parent. Reverse order keeps each ancestor's parent GAS-owned
        // until after it has been transferred, because a parent always precedes its
        // descendants in the sorted manifest. GAS-owned ancestors are skipped (already
        // left GAS-owned by the create pass); leaves were already transferred above.
        for(let i = rows.length - 1; i >= 0; i--)
            if(ancestors.has(rows[i].tick) && rows[i].owner !== gas)
                await this._issue(gas, rows[i].tick, rows[i].owner, blockToParse, blockTime, 2);

        // Airdrop pass: credit the XCP/XDP native-token allocation to snapshot
        // holders. Runs after the name passes so the whole genesis block stays one
        // deterministic action sequence: gas token, creates, ancestor transfers, credits.
        await this._injectAirdrops(gas, blockToParse, blockTime);

        } finally {
            this.indexerDb._internCache = null;
        }

        console.log('GENESIS: complete - ' + rows.length + ' names injected');
    }

    // sha256 the manifest and compare to the pinned GENESIS_LEDGER_HASH. A null pin
    // skips the check (pre-pin dev/regtest); a mismatch halts the node, since applying
    // a different manifest would fork the ledger.
    _verifyManifest(file){
        let expected = this.config['GENESIS_LEDGER_HASH'];
        if(this.util.isNull(expected))
            return;
        let actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        if(actual !== String(expected).toLowerCase()){
            console.error('GENESIS FATAL: ledger hash mismatch for ' + file + ' (expected ' + expected + ', got ' + actual + '). Halting.');
            throw new Error('Genesis ledger hash mismatch');
        }
    }

    // Read the manifest CSV (tick,owner_address). Owner addresses never contain a comma,
    // so the LAST comma separates tick from owner (ticks may be RFC4180-quoted and could
    // in principle contain commas). Dedupe by tick (last row wins) and skip ticks the
    // ISSUE handler would reject anyway. Finally assert parent-before-child ordering so a
    // malformed manifest fails before any DB write rather than mid-injection.
    _loadRows(file){
        let lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        let rows  = [];
        let index = new Map(); // tick -> position in rows (dedupe)
        for(let line of lines){
            if(line === '' || line === 'tick,owner_address')
                continue;
            let comma = line.lastIndexOf(',');
            if(comma < 0)
                continue;
            let tick  = line.slice(0, comma).trim();
            let owner = line.slice(comma + 1).trim();
            // Unwrap an RFC4180-quoted tick ("..."" -> ").
            if(tick.length >= 2 && tick[0] === '"' && tick[tick.length - 1] === '"')
                tick = tick.slice(1, -1).replace(/""/g, '"');
            if(tick === '' || owner === '')
                continue;
            // Protocol sanity (the handler rejects these too; skip + log rather than abort).
            if(tick.indexOf('|') !== -1 || tick.indexOf(';') !== -1){
                console.warn('GENESIS skip (separator char in tick): ' + tick);
                continue;
            }
            if(tick.length > this.config['MAX_TICK_LENGTH']){
                console.warn('GENESIS skip (tick exceeds MAX_TICK_LENGTH): ' + tick);
                continue;
            }
            if(index.has(tick))
                rows[index.get(tick)].owner = owner;  // last row wins
            else {
                index.set(tick, rows.length);
                rows.push({ tick: tick, owner: owner });
            }
        }
        // Parent-before-child invariant: a child's immediate parent must already appear.
        let present = new Set();
        for(let r of rows){
            let parts = r.tick.split('.');
            if(parts.length > 1){
                let parent = parts.slice(0, -1).join('.');
                if(!present.has(parent))
                    throw new Error('GENESIS FATAL: child "' + r.tick + '" precedes its parent "' + parent + '" in the manifest');
            }
            present.add(r.tick);
        }
        return rows;
    }

    // Build the set of ancestor ticks: a tick is an ancestor if some other loaded tick
    // names it as a parent prefix (e.g. "A" and "A.B" make "A" an ancestor). Each tick's
    // own strict prefixes are added only when they are themselves present in the manifest,
    // so the set contains real reserved names that gate at least one descendant's creation.
    // The parent-before-child invariant is already asserted in _loadRows.
    _ancestorSet(rows){
        let present   = new Set(rows.map(r => r.tick));
        let ancestors = new Set();
        for(let r of rows){
            let parts = r.tick.split('.');
            for(let i = 1; i < parts.length; i++){
                let prefix = parts.slice(0, i).join('.');
                if(present.has(prefix))
                    ancestors.add(prefix);
            }
        }
        return ancestors;
    }

    // Synthesize one genesis action and run it through the normal action pipeline with the
    // genesis flag set (fee-exempt + wrong-network TRANSFER allowed; see issue.js / actions.js).
    // pass 1 = create from GAS (with TRANSFER=owner for a leaf, no TRANSFER for an ancestor);
    // pass 2 = the deferred ancestor transfer (re-issue from GAS with TRANSFER=owner). The pass
    // number feeds the tx hash, so a leaf (pass 1 only) and an ancestor (pass 1 + pass 2) never
    // collide. The tx hash is deterministic so a reindex replays to identical action indexes/hashes.
    async _issue(gas, tick, transfer, blockToParse, blockTime, pass){
        // ISSUE format 0: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|TRANSFER|...
        let fields = ['ISSUE', '0', tick];
        if(!this.util.isNull(transfer))
            fields.push('', '', '', '', '', transfer); // skip the 5 fields before TRANSFER
        // Deterministic, fixed-width synthetic tx hash. Embedding the raw tick overflowed
        // the 64-char unique prefix on index_transactions.hash, so long ticks sharing a
        // 64-char prefix collided to a NULL tx_hash_id. A sha256 digest of (coin,pass,tick)
        // keeps the hash deterministic and collision-free inside the indexed width; the
        // readable GENESIS-<coin>-P<pass>- prefix preserves explorer legibility (64 chars).
        let digest = crypto.createHash('sha256')
            .update(this.config['COIN'] + '|' + pass + '|' + tick).digest('hex').slice(0, 48);
        let tx = {
            data:          fields.join('|'),
            source:        gas,
            destination:   null,
            amount:        null,
            tx_hash:       'GENESIS-' + this.config['COIN'] + '-P' + pass + '-' + digest,
            vout:          0,
            block_index:   blockToParse,
            block_time:    blockTime,
            raw_data:      null,
            fee:           null,
            source_pubkey: null,
            tx_outputs:    []
        };
        await this.actions.processTransaction(tx, true); // isGenesis = true
    }

    // Airdrop pass: credit the CP/DP native-token (XCP/XDP) airdrop allocation to snapshot
    // holders, pro-rata within each configured bucket. Config-driven and disabled by default
    // (GENESIS_AIRDROP_PATHS empty): each bucket is a hash-pinned `address,quantity` CSV plus
    // an XCHAIN amount (GENESIS-PARAMETERS.md: 30,000,000 total across the CP+DP buckets;
    // the per-bucket split is set at arming). Each credit is a synthetic ISSUE (format 2)
    // from GAS with MINT_SUPPLY + TRANSFER_SUPPLY, so the mint and the holder credit ride
    // the normal action pipeline in one action and empty fields inherit the token's params.
    // Flooring every credit at the 8-decimal grid guarantees the minted sum never exceeds
    // the bucket amount (the sub-satoshi remainder is simply never minted).
    async _injectAirdrops(gas, blockToParse, blockTime){
        let buckets = this._airdropBuckets();
        let pin     = this.config['GENESIS_AIRDROP_SET_HASH'] || null;
        if(buckets.length === 0){
            // A pinned set with nothing armed is the DISARMED half of the same divergence:
            // this node would derive a genesis with no airdrop actions at all while its
            // peers mint the pinned set. Halt rather than quietly skip an allocation:
            // the pin is the operator's own statement that a set exists.
            if(pin)
                throw new Error('GENESIS FATAL: an airdrop set-hash is pinned (' + pin + ') but no airdrop buckets are '
                    + 'configured. The pinned coin bundle (src/coins/' + this.config['COIN'] + '.js, genesis.airdrop*) '
                    + 'is inconsistent: either arm the buckets it pins or clear the pin.');
            return;
        }
        let tick     = this.config['GAS']; // 'XCHAIN'
        let snapshot = this.config['GENESIS_AIRDROP_SNAPSHOT_BLOCK'] || 'unpinned';
        // Combined set-hash over the canonical bucket order (name:hash:amount per line):
        // operators on different nodes compare this one line to prove they armed the
        // identical airdrop set before any consensus action is derived.
        let setHash = this._airdropSetHash(buckets);
        console.log('GENESIS: airdrop set-hash ' + setHash + ' (' + buckets.length + ' buckets, canonical order '
            + buckets.map(b => b.name).join(',') + ')');
        // ENFORCE it. Until this check the set-hash was a log line and
        // nothing else: the per-bucket GENESIS_AIRDROP_HASHES pin each snapshot FILE, so two
        // nodes with byte-identical CSVs still passed every check while minting different
        // XCHAIN amounts (the amounts were pinned nowhere) or deriving different synthetic tx
        // hashes (the bucket NAMES, hence the set membership, were pinned nowhere). This pins
        // the set itself, and it runs before the first credit so a mismatch halts a node
        // instead of forking it.
        if(pin){
            if(setHash !== String(pin).toLowerCase()){
                console.error('GENESIS FATAL: airdrop set-hash mismatch (expected ' + pin + ', got ' + setHash + '). Halting.');
                throw new Error('Genesis airdrop set-hash mismatch (expected ' + pin + ', got ' + setHash + ')');
            }
        } else if(this.config['NETWORK'] === 'mainnet'){
            // Mainnet fails closed on an UNPINNED set for the same reason it already fails
            // closed on an unpinned bucket file: the CSV fallback is the derivation path of
            // record only when every consensus input it consumes is pinned in the bundle.
            throw new Error('GENESIS FATAL: mainnet airdrop set is not pinned (genesis.airdropSetHash / '
                + 'GENESIS_AIRDROP_SET_HASH). The computed set-hash is ' + setHash + '; pin it in the coin bundle '
                + 'and re-vendor before a mainnet node derives the airdrop from CSVs.');
        }
        for(let b of buckets){
            this._verifyAirdropFile(b);
            let rows  = this._loadAirdropRows(b.file);
            let total = '0';
            for(let r of rows)
                total = this.util.bcadd(total, r.quantity, 8);
            if(!this.util.bcgt(total, 0))
                throw new Error('GENESIS FATAL: airdrop snapshot ' + b.file + ' has no positive holder quantities');
            console.log('GENESIS: airdrop bucket ' + b.name + ' - ' + rows.length + ' holders, '
                + b.amount + ' ' + tick + ' (snapshot block ' + snapshot + ')');
            let credited = 0;
            for(let r of rows){
                let credit = this._prorate(b.amount, r.quantity, total);
                if(!this.util.bcgt(credit, 0))
                    continue; // holder's share floors to zero at 8 decimals
                await this._creditIssue(gas, tick, r.address, credit, b.name, blockToParse, blockTime);
                credited++;
            }
            console.log('GENESIS: airdrop bucket ' + b.name + ' complete - ' + credited + ' credits');
        }
    }

    // sha256 over the canonical `name:hash:amount` line per bucket, newline-joined, in the
    // canonical (name-sorted) bucket order _airdropBuckets returns. The line format is the
    // pinned wire form: changing it changes every armed pin, so it is fixed here and mirrored
    // in the arming runbook. An unpinned bucket contributes the literal 'unpinned', so an
    // unpinned set and a pinned one never collide.
    _airdropSetHash(buckets){
        return crypto.createHash('sha256')
            .update(buckets.map(b => b.name + ':' + (b.hash || 'unpinned') + ':' + b.amount).join('\n'))
            .digest('hex');
    }

    // Zip GENESIS_AIRDROP_PATHS / _HASHES / _AMOUNTS into bucket descriptors, failing closed
    // on a missing or malformed amount (an unfunded bucket is a launch-cut mistake, not a
    // skippable row). Bucket name = uppercased file basename (xcp.csv -> XCP); it feeds the
    // synthetic tx hash, so two buckets must not share a basename.
    _airdropBuckets(){
        let paths = this.config['GENESIS_AIRDROP_PATHS'] || [];
        if(paths.length === 0)
            return [];
        let hashes  = this.config['GENESIS_AIRDROP_HASHES']  || [];
        let amounts = this.config['GENESIS_AIRDROP_AMOUNTS'] || [];
        if(amounts.length !== paths.length)
            throw new Error('GENESIS FATAL: GENESIS_AIRDROP_AMOUNTS must carry one amount per GENESIS_AIRDROP_PATHS entry');
        let buckets = [];
        let names   = new Set();
        for(let i = 0; i < paths.length; i++){
            let name   = path.basename(paths[i]).replace(/\.[^.]*$/, '').toUpperCase();
            let amount = amounts[i];
            // Deliberately a TWO-argument call: no blockTime, so the amount-representability
            // gate (amount_representability_activation.js) stays inert here. This validates
            // operator GENESIS config at boot, not a wire-submitted action against a
            // processing block, and there is no consensus timestamp to key the gate on. A
            // genesis config carrying an unrepresentable amount is an operator-facing boot
            // failure to fix in the config, not a consensus acceptance question.
            if(this.util.isNull(amount) || !this.util.isValidAmountFormat(8, amount) || !this.util.bcgt(amount, 0))
                throw new Error('GENESIS FATAL: invalid airdrop amount "' + amount + '" for bucket ' + name);
            if(names.has(name))
                throw new Error('GENESIS FATAL: duplicate airdrop bucket name ' + name);
            names.add(name);
            let hash = hashes[i] || null;
            // Mainnet CSV fallback fails closed: the expected mainnet path is the
            // pinned genesis dump; a CSV-derived mainnet genesis is only tolerated when every
            // bucket carries a sha256 pin, so unpinned content can never enter consensus.
            if(this.config['NETWORK'] === 'mainnet' && !/^[0-9a-fA-F]{64}$/.test(String(hash || '')))
                throw new Error('GENESIS FATAL: mainnet airdrop bucket ' + name + ' has no sha256 pin (GENESIS_AIRDROP_HASHES); mainnet CSV genesis requires every bucket pinned (expected path is the genesis dump)');
            buckets.push({ name: name, file: paths[i], hash: hash, amount: amount });
        }
        // Canonical order: action_index is a hashed consensus field, so bucket
        // iteration order must not depend on the operator's env-var CSV order. Bucket names
        // are unique (checked above), so a byte-order sort on name is total + deterministic.
        buckets.sort((a, b) => a.name < b.name ? -1 : 1);
        return buckets;
    }

    // sha256-pin check for one airdrop snapshot, mirroring _verifyManifest: a null pin skips
    // (pre-pin dev/regtest), a mismatch halts the node, and a missing file always halts (an
    // armed bucket without its snapshot must never silently skip the whole allocation).
    _verifyAirdropFile(bucket){
        if(!fs.existsSync(bucket.file))
            throw new Error('GENESIS FATAL: airdrop snapshot missing: ' + bucket.file);
        if(this.util.isNull(bucket.hash))
            return;
        let actual = crypto.createHash('sha256').update(fs.readFileSync(bucket.file)).digest('hex');
        if(actual !== String(bucket.hash).toLowerCase()){
            console.error('GENESIS FATAL: airdrop snapshot hash mismatch for ' + bucket.file + ' (expected ' + bucket.hash + ', got ' + actual + '). Halting.');
            throw new Error('Genesis airdrop snapshot hash mismatch');
        }
    }

    // Read one snapshot CSV (address,quantity). Addresses never contain a comma, so the
    // LAST comma splits the fields (symmetric with _loadRows). Duplicate addresses sum
    // (first-seen position wins for ordering, keeping the injection order pinned to the
    // hash-pinned file order); non-numeric or non-positive quantities are skipped + logged.
    // CP/DP quantities carry at most 8 decimals, matching the bcadd precision here.
    _loadAirdropRows(file){
        let lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        let rows  = [];
        let index = new Map(); // address -> position in rows (dedupe)
        for(let line of lines){
            if(line === '' || line === 'address,quantity')
                continue;
            let comma = line.lastIndexOf(',');
            if(comma < 0)
                continue;
            let address  = line.slice(0, comma).trim();
            let quantity = line.slice(comma + 1).trim();
            if(address === '' || quantity === '')
                continue;
            if(!this.util.isNumeric(quantity) || !this.util.bcgt(quantity, 0)){
                console.warn('GENESIS skip (bad airdrop quantity): ' + address + ',' + quantity);
                continue;
            }
            if(index.has(address)){
                let r = rows[index.get(address)];
                r.quantity = this.util.bcadd(r.quantity, quantity, 8);
            } else {
                index.set(address, rows.length);
                rows.push({ address: address, quantity: quantity });
            }
        }
        return rows;
    }

    // Pro-rata share: floor(amount * quantity / total) at the gas token's 8-decimal grid,
    // computed entirely in bignumber space (util.bcnum is decimal.js-backed). Flooring is
    // consensus-critical the same way bcmulfloor is: every node must derive the identical
    // credit, and rounding down keeps the bucket's minted sum <= its configured amount.
    _prorate(amount, quantity, total){
        let share = this.util.bcnum(amount).times(this.util.bcnum(quantity)).div(this.util.bcnum(total));
        return share.times('100000000').floor().div('100000000').toFixed(8);
    }

    // Synthesize one airdrop credit: ISSUE format 2 from GAS carrying only MINT_SUPPLY and
    // TRANSFER_SUPPLY (VERSION|TICK|MAX_MINT|MINT_SUPPLY|TRANSFER_SUPPLY|...), so the token's
    // existing params are untouched (empty ISSUE fields inherit the current settings) and the
    // pipeline both mints the credit and lands it on the holder in a single action. The tx
    // hash digests (coin, bucket, address): addresses are deduped per bucket, so it is unique.
    async _creditIssue(gas, tick, holder, credit, bucketName, blockToParse, blockTime){
        let fields = ['ISSUE', '2', tick,
            '',       // MAX_MINT (inherit)
            credit,   // MINT_SUPPLY
            holder    // TRANSFER_SUPPLY
        ];
        let digest = crypto.createHash('sha256')
            .update(this.config['COIN'] + '|AIRDROP|' + bucketName + '|' + holder).digest('hex').slice(0, 48);
        let tx = {
            data:          fields.join('|'),
            source:        gas,
            destination:   null,
            amount:        null,
            tx_hash:       'GENESIS-' + this.config['COIN'] + '-A-' + digest,
            vout:          0,
            block_index:   blockToParse,
            block_time:    blockTime,
            raw_data:      null,
            fee:           null,
            source_pubkey: null,
            tx_outputs:    []
        };
        await this.actions.processTransaction(tx, true); // isGenesis = true
    }

    // Inject the XCHAIN gas token as the first genesis action. Unlike the bare name
    // reservations, the gas token carries real parameters: 8 decimals and a 100,000,000
    // MAX_SUPPLY, owned by GAS, with zero pre-mint (supply 0). MINT_START_BLOCK is pinned to a
    // far-future sentinel so the token exists but is un-mintable until the operator lowers it
    // via a later GAS-signed ISSUE (the launch open-mint). Decimals stay editable until the
    // first mint (issue.js locks them only once SUPPLY > 0), so the launch ISSUE can still
    // tune caps/window while supply is 0. The synthetic tx hash uses a distinct GAS marker so
    // it never collides with the per-name create/transfer passes.
    async _injectGasToken(gas, blockToParse, blockTime){
        let tick = this.config['GAS']; // 'XCHAIN'
        // Routed through the shared creation helper so the BTC genesis row and the row the
        // bridge creates off BTC come out of ONE code path (xchain-bridge.md section 9, D66):
        // two independent paths would drift, and a drifted parameter is a different token row
        // on two chains, which is a different ledger hash. The parameter set is the same
        // object the bridge passes, so "byte-identical" is a fact of the code, not a promise.
        // The synthesized transaction (data string, tx hash, source, vout) is byte-identical
        // to the pre-refactor one; test/unit/genesis-bridge-replay-pin.test.js pins both
        // literals, so genesis replays to the same hashes on every chain.
        // skipExistsProbe: the genesis pass runs once, at a block-keyed height, and this is the
        // FIRST action of that block, so the row provably cannot be there yet. The probe the
        // bridge needs (many in-legs, one row) would only add a read to the one block whose
        // replay every node has to reproduce, so genesis keeps the read it never had.
        console.log('GENESIS: injecting gas token ' + tick + ' (decimals 8, max_supply 100000000, mint disabled) owned by GAS');
        await this.injectProtocolToken(this.gasTokenParams(gas), {
            blockIndex:      blockToParse,
            blockTime:       blockTime,
            txHashPrefix:    'GENESIS-',
            skipExistsProbe: true
        });
    }

    /**
     * The gas token parameter set, in one place, for both creation sites: this chain's
     * genesis pass on BTC mainnet and the bridge's first XBRIDGE v2 in-leg on DOGE/LTC.
     * Callers MUST NOT retype these values (D66: the XCHAIN call site passes the
     * byte-identical set, and that is a hard obligation, not a preference).
     *
     * @param {string} [owner] - the owning address; defaults to this chain's ADDRESS.GAS
     * @returns {Object} the injectProtocolToken parameter set for XCHAIN
     */
    gasTokenParams(owner){
        return {
            tick:           this.config['GAS'],
            owner:          this.util.isNull(owner) ? this.config['ADDRESS']['GAS'] : owner,
            maxSupply:      '100000000',
            decimals:       '8',
            lockMaxSupply:  '',                 // never locked: the launch ISSUE still tunes the cap
            mintStartBlock: '999999999',        // sentinel: mint disabled until the operator lowers it
            mintSupply:     '',                 // no pre-mint
            description:    'XChain gas token',
            locks:          {}
        };
    }

    /**
     * Build the ISSUE format 0 field list for a parameter set. The field ORDER is
     * issue.js formats[0] and is consensus: VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|
     * DESCRIPTION|MINT_SUPPLY|TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|
     * LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|
     * CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|
     * MINT_STOP_BLOCK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO.
     *
     * TRAILING EMPTY FIELDS ARE TRIMMED, and that trim is what keeps the gas token's wire
     * string byte-identical: the gas set touches nothing past MINT_START_BLOCK, so the three
     * later fields a bridged row needs (LOCK_MINT and LOCK_MINT_SUPPLY, and the
     * MINT_STOP_BLOCK placeholder between them) disappear from its data string exactly as
     * they did before this helper existed. The parser tolerates a short field list.
     *
     * There is never a TRANSFER: every injected row is created owned by its final owner.
     *
     * @param {Object} params - see injectProtocolToken
     * @returns {string[]} the field list, ready to join with '|'
     */
    _issueFields(params){
        let locks = params.locks || {};
        let v     = (x) => this.util.isNull(x) ? '' : String(x);
        let fields = [
            'ISSUE',
            '0',
            String(params.tick),
            v(params.maxSupply),             // MAX_SUPPLY (empty = uncapped sentinel)
            '',                              // MAX_MINT (no per-tx cap)
            v(params.decimals),              // DECIMALS
            v(params.description),           // DESCRIPTION
            v(params.mintSupply),            // MINT_SUPPLY
            '',                              // TRANSFER (owner is the SOURCE)
            '',                              // TRANSFER_SUPPLY
            v(params.lockMaxSupply),         // LOCK_MAX_SUPPLY
            v(locks['LOCK_MAX_MINT']),       // LOCK_MAX_MINT
            v(locks['LOCK_DESCRIPTION']),    // LOCK_DESCRIPTION
            v(locks['LOCK_SLEEP']),          // LOCK_SLEEP
            v(locks['LOCK_CALLBACK']),       // LOCK_CALLBACK
            '',                              // CALLBACK_BLOCK
            '',                              // CALLBACK_TICK
            '',                              // CALLBACK_AMOUNT
            '',                              // ALLOW_LIST
            '',                              // BLOCK_LIST
            '',                              // MINT_ADDRESS_MAX
            v(params.mintStartBlock),        // MINT_START_BLOCK
            '',                              // MINT_STOP_BLOCK
            v(locks['LOCK_MINT']),           // LOCK_MINT
            v(locks['LOCK_MINT_SUPPLY'])     // LOCK_MINT_SUPPLY
        ];
        while(fields.length > 3 && fields[fields.length - 1] === '')
            fields.pop();
        return fields;
    }

    /**
     * Wrap a field list in the synthetic transaction the injected passes use. The tx hash is
     * deterministic so a reindex replays to identical action indexes and hashes.
     *
     * HASH SHAPE: <txHashPrefix><COIN>-<family>-<48 hex of sha256(COIN|family|tick[|salt])>.
     * The gas token's family is 'GAS' and it carries no salt, which is exactly the
     * pre-refactor preimage and prefix, so its hash does not move. `family` separates the
     * synthetic transaction families so an injected row can never collide with another
     * pass's hash; `salt` distinguishes two injections for the SAME tick in the same family
     * (the decimals re-parameterization below, where the new precision is the salt).
     *
     * @param {string[]} fields - from _issueFields
     * @param {string} tick     - the tick, which is the hash preimage's identity component
     * @param {string} source   - the injecting address
     * @param {Object} ctx      - { blockIndex, blockTime, txHashPrefix, txHashFamily, txHashSalt }
     * @returns {Object} the synthetic transaction
     */
    _syntheticIssueTx(fields, tick, source, ctx){
        let prefix = this.util.isNull(ctx.txHashPrefix) ? 'GENESIS-' : String(ctx.txHashPrefix);
        let family = this.util.isNull(ctx.txHashFamily) ? 'GAS'      : String(ctx.txHashFamily);
        let salt   = this.util.isNull(ctx.txHashSalt)   ? ''         : '|' + String(ctx.txHashSalt);
        let digest = crypto.createHash('sha256')
            .update(this.config['COIN'] + '|' + family + '|' + tick + salt).digest('hex').slice(0, 48);
        return {
            data:          fields.join('|'),
            source:        source,
            destination:   null,
            amount:        null,
            tx_hash:       prefix + this.config['COIN'] + '-' + family + '-' + digest,
            vout:          0,
            block_index:   ctx.blockIndex,
            block_time:    ctx.blockTime,
            raw_data:      null,
            fee:           null,
            source_pubkey: null,
            tx_outputs:    []
        };
    }

    /**
     * Read a token row WITHOUT interning a ticker id. getTokenInfo() calls createTicker(),
     * which assigns an index_tickers id to a tick that may never be created; that would move
     * the dense id order and therefore the replay, so the probe goes through getTickerId
     * (a plain SELECT) first and only reads the row when an id already exists.
     *
     * @param {string} tick
     * @returns {Promise<Object|null>} the getTokenInfo record, or null when no row exists
     */
    async _tokenRow(tick){
        let id = await this.indexerDb.getTickerId(tick);
        if(this.util.isNull(id))
            return null;
        let info = await this.indexerDb.getTokenInfo(tick);
        return info ? info : null;
    }

    /**
     * SEAM (lane L5 builds the body). The shared token-row creation helper, factored OUT of
     * _injectGasToken so one code path creates a token row from a parameter set, whether the
     * caller is the BTC genesis pass or a bridge settle leg on another chain.
     *
     * WHY A HELPER AT ALL. The XCHAIN row on DOGE and LTC must be byte-for-byte the row
     * _injectGasToken writes on BTC, and a general bridged row must be created the same way.
     * Two independent creation paths would drift, and a drifted parameter is a different
     * token row on two chains, which is a different ledger hash.
     *
     * THE XCHAIN CALL SITE PASSES THE BYTE-IDENTICAL _injectGasToken SET. That is the whole
     * contract of this refactor and it is a hard obligation, not a preference: genesis must
     * be byte-identical before and after on every chain, which the replay pin test asserts.
     * _injectGasToken itself is NOT rewritten by this seam.
     *
     * ROUTED THROUGH processTransaction(tx, true), so the row is ACTION-DERIVED: its
     * index_tickers id is assigned at a consensus action index and it enters the hashes for
     * free. The `true` stamps data['IS_GENESIS'], which is also what exempts the injected
     * creation from the bridge-owned ISSUE refusal off BTC and from the reserved-tick guard.
     * A broadcast action never carries that flag, so no historical verdict moves.
     *
     * IDEMPOTENT. A row that already exists is a no-op, not an error: the first XBRIDGE
     * in-leg on a chain creates it and every later leg finds it.
     *
     * @param {Object} params - the token parameter set, one per ISSUE format 0 field:
     * @param {string} params.tick           - ticker name ('XCHAIN' for the gas token; the
     *                                         rooted <ORIGIN>.<NAME> form for a bridged row)
     * @param {string} params.owner          - owning address (ADDRESS.GAS for the gas token,
     *                                         ADDRESS.BRIDGE_<ORIGIN> for a bridged row,
     *                                         which is keyless by design)
     * @param {string} params.maxSupply      - MAX_SUPPLY ('100000000' for the gas token;
     *                                         omitted, stored 0, the uncapped sentinel, for
     *                                         a bridged row, because a copied cap would go
     *                                         stale on the origin's next MINT)
     * @param {string|number} params.decimals - DECIMALS (8 for the gas token; the signed
     *                                         `decimals` from the transfer record for a
     *                                         bridged child row; 0 for a bridge root row)
     * @param {string} params.lockMaxSupply  - LOCK_MAX_SUPPLY (empty for the gas token, and
     *                                         NOT set on a bridged row: locking with no
     *                                         positive cap is refused)
     * @param {string|number} params.mintStartBlock - MINT_START_BLOCK (999999999, the
     *                                         sentinel that disables mint until lowered)
     * @param {string} params.mintSupply     - MINT_SUPPLY (empty: no pre-mint)
     * @param {string} params.description    - DESCRIPTION
     * @param {Object} params.locks          - the remaining lock flags as an object keyed by
     *                                         wire field name (LOCK_MINT, LOCK_MINT_SUPPLY,
     *                                         LOCK_MAX_MINT, LOCK_DESCRIPTION, LOCK_SLEEP,
     *                                         LOCK_CALLBACK); empty for the gas token, all
     *                                         set on a bridged row
     * @param {Object} ctx - creation context: { blockIndex, blockTime, txHashPrefix }.
     *                       txHashPrefix distinguishes the synthetic transaction families
     *                       ('GENESIS-' for the genesis pass, 'XPOLICY-' for a policy leg),
     *                       so an injected row can never collide with another pass's hash.
     *                       Three optional fields extend it, all defaulting to the genesis
     *                       behaviour so the seam's three-field ctx keeps producing the
     *                       historical transaction: `txHashFamily` (default 'GAS') is the
     *                       readable hash segment AND the digest's domain separator,
     *                       `txHashSalt` distinguishes two injections for the same tick in
     *                       the same family, and `skipExistsProbe` skips the idempotency
     *                       read for a caller that already knows the row is absent
     * @returns {Promise<{created: boolean, tick: string}>} created false when the row was
     *          already present
     */
    async injectProtocolToken(params, ctx){
        ctx = ctx || {};
        let tick = String(params.tick);
        // Idempotent by design: the first in-leg on a chain creates the row and every later
        // leg finds it. An existing row is a no-op and NOT an error, so a settle pass never
        // has to know whether it is the first one. ctx.skipExistsProbe is for the one caller
        // that already knows the row cannot be there (see _injectGasToken).
        if(!ctx.skipExistsProbe){
            let existing = await this._tokenRow(tick);
            if(existing)
                return { created: false, tick: tick };
        }
        let tx = this._syntheticIssueTx(this._issueFields(params), tick, params.owner, ctx);
        await this.actions.processTransaction(tx, true); // isGenesis = true (stamps IS_GENESIS)
        return { created: true, tick: tick };
    }

    /**
     * Create the two rows a bridged token needs on THIS chain, as
     * the token bridge spec section 6 specifies them, and enforce the
     * existing-row rules. Called by the settle pass (lane L14) on a v5 in-leg, before any
     * credit; the caller logs the single refusal line naming the transfer id.
     *
     * 1. The root row `<ORIGIN>` if absent: owned by this chain's bridge role address for
     *    that origin, uncapped (MAX_SUPPLY omitted, stored 0), DECIMALS 0, every lock set.
     *    LOCK_MAX_SUPPLY is deliberately NOT set: locking with no positive cap is refused
     *    (issue.js), and nothing can mint anyway (mint locked, window at the sentinel, owner
     *    keyless). One per origin chain per destination chain, ever.
     * 2. The child row `<ORIGIN>.<NAME>`: the same owner and locks, DECIMALS from the signed
     *    record, uncapped (a copied cap would go stale on the origin's next MINT). Nothing
     *    else is copied from the origin (D19).
     *
     * EXISTING ROWS. A root owned by anyone but the bridge role address refuses the leg: that
     * is only possible on a chain that squatted the name before the reserved-tick guard
     * landed, and minting under someone else's root would hand them the child's parent gate.
     * The child needs no separate owner check, because a child under a bridge-owned root can
     * only have been created by the bridge (issue.js's parent gate refuses any other source).
     * A child whose DECIMALS already match applies; different decimals with SUPPLY 0
     * re-parameterize the row (the rule issue.js gives every token: decimals move until
     * supply exists); different decimals WITH supply refuse and apply nothing (D16).
     *
     * @param {Object} params - { origin, name, decimals, owner }: the origin chain's coin
     *                          symbol, the origin's native tick (never rooted), the signed
     *                          decimals from the transfer record, and this chain's
     *                          ADDRESS.BRIDGE_<ORIGIN>
     * @param {Object} ctx - { blockIndex, blockTime, txHashPrefix }, as injectProtocolToken
     * @returns {Promise<{ok: boolean, reason: (string|null), tick: string, rootCreated:
     *          boolean, childCreated: boolean, reparameterized: boolean}>} ok false means
     *          apply NOTHING; `reason` is what the caller's single log line names
     */
    async injectBridgedToken(params, ctx){
        ctx = ctx || {};
        let origin = String(params.origin);
        let owner  = params.owner;
        let child  = origin + '.' + String(params.name);
        let out    = { ok: true, reason: null, tick: child, rootCreated: false, childCreated: false, reparameterized: false };

        // Root row.
        let rootInfo = await this._tokenRow(origin);
        if(rootInfo){
            if(String(rootInfo['OWNER']) !== String(owner)){
                out.ok     = false;
                out.reason = 'root row ' + origin + ' is owned by ' + rootInfo['OWNER'] + ', not the bridge role address ' + owner;
                return out;
            }
        } else {
            let res = await this.injectProtocolToken({
                tick:           origin,
                owner:          owner,
                maxSupply:      '',             // uncapped sentinel
                decimals:       '0',
                lockMaxSupply:  '',             // see the method comment: never set
                mintStartBlock: '999999999',
                mintSupply:     '',
                description:    'Bridge root for assets native to ' + origin,
                locks:          BRIDGE_ROW_LOCKS
            }, Object.assign({}, ctx, { txHashFamily: 'BRIDGE' }));
            out.rootCreated = res.created;
        }

        // Child row.
        let childInfo = await this._tokenRow(child);
        if(!childInfo){
            let res = await this.injectProtocolToken({
                tick:           child,
                owner:          owner,
                maxSupply:      '',             // uncapped sentinel
                decimals:       String(params.decimals),
                lockMaxSupply:  '',
                mintStartBlock: '999999999',
                mintSupply:     '',
                description:    'Bridged from ' + origin,
                locks:          BRIDGE_ROW_LOCKS
            }, Object.assign({}, ctx, { txHashFamily: 'BRIDGE' }));
            out.childCreated = res.created;
            return out;
        }

        if(String(childInfo['DECIMALS']) === String(params.decimals))
            return out;

        let supply = this.util.isNull(childInfo['SUPPLY']) ? '0' : String(childInfo['SUPPLY']);
        if(this.util.bcgt(supply, '0')){
            out.ok     = false;
            out.reason = 'decimals mismatch on ' + child + ': record ' + params.decimals + ', row ' + childInfo['DECIMALS'] + ', supply ' + supply;
            return out;
        }

        // SUPPLY is 0, so the precision still moves. An ISSUE format 0 carrying only the new
        // DECIMALS: every empty field back-fills from the current row, so the owner, locks,
        // description and window are untouched. The new precision is the hash salt, which is
        // what keeps this transaction distinct from the creation (and from a later
        // re-parameterization to a different precision) for the same tick.
        let fields = ['ISSUE', '0', child, '', '', String(params.decimals)];
        let tx     = this._syntheticIssueTx(fields, child, owner,
            Object.assign({}, ctx, { txHashFamily: 'BRIDGEDEC', txHashSalt: String(params.decimals) }));
        await this.actions.processTransaction(tx, true); // isGenesis = true
        out.reparameterized = true;
        return out;
    }
}

module.exports = Genesis;

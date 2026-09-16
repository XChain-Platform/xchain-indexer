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
 * XChain Indexer - Genesis Mixin: Airdrops
 *
 * The XCP/XDP native-token airdrop pass: bucket discovery, the set-hash pin that
 * proves two nodes armed the identical bucket set, and the per-holder credits.
 * Installed onto Genesis.prototype by ../genesis.js, so call sites stay
 * this.injectAirdrops() etc.
 *
 ********************************************************************/

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { getLogger } = require('../../observability/index.js');

module.exports = {

    // Airdrop pass: credit the CP/DP native-token (XCP/XDP) airdrop allocation to snapshot
    // holders, pro-rata within each configured bucket. Config-driven and disabled by default
    // (GENESIS_AIRDROP_PATHS empty): each bucket is a hash-pinned `address,quantity` CSV plus
    // an XCHAIN amount (GENESIS-PARAMETERS.md: 30,000,000 total across the CP+DP buckets;
    // the per-bucket split is set at arming). Each credit is a synthetic ISSUE (format 2)
    // from GAS with MINT_SUPPLY + TRANSFER_SUPPLY, so the mint and the holder credit ride
    // the normal action pipeline in one action and empty fields inherit the token's params.
    // Flooring every credit at the 8-decimal grid guarantees the minted sum never exceeds
    // the bucket amount (the sub-satoshi remainder is simply never minted).
    async injectAirdrops(gas, blockToParse, blockTime){
        let buckets = this.airdropBuckets();
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
        this.verifyAirdropSetHash(buckets, pin);
        for(let b of buckets)
            await this.creditAirdropBucket(gas, tick, b, snapshot, blockToParse, blockTime);
    },

    // Compute the airdrop set-hash, log it, and hold it to the pin before the first
    // credit is derived; mainnet refuses an unpinned set outright.
    verifyAirdropSetHash(buckets, pin){
        // Combined set-hash over the canonical bucket order (name:hash:amount per line):
        // operators on different nodes compare this one line to prove they armed the
        // identical airdrop set before any consensus action is derived.
        let setHash = this.airdropSetHash(buckets);
        getLogger().info('GENESIS: airdrop set-hash ' + setHash + ' (' + buckets.length + ' buckets, canonical order '
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
                getLogger().error('GENESIS FATAL: airdrop set-hash mismatch (expected ' + pin + ', got ' + setHash + '). Halting.');
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
    },

    // Verify one airdrop bucket's snapshot and credit each holder its pro-rata share, in
    // the hash-pinned file order loadAirdropRows returns.
    async creditAirdropBucket(gas, tick, b, snapshot, blockToParse, blockTime){
        this.verifyAirdropFile(b);
        let rows  = this.loadAirdropRows(b.file);
        let total = '0';
        for(let r of rows)
            total = this.util.bcadd(total, r.quantity, 8);
        if(!this.util.bcgt(total, 0))
            throw new Error('GENESIS FATAL: airdrop snapshot ' + b.file + ' has no positive holder quantities');
        getLogger().info('GENESIS: airdrop bucket ' + b.name + ' - ' + rows.length + ' holders, '
            + b.amount + ' ' + tick + ' (snapshot block ' + snapshot + ')');
        let credited = 0;
        for(let r of rows){
            let credit = this.prorate(b.amount, r.quantity, total);
            if(!this.util.bcgt(credit, 0))
                continue; // holder's share floors to zero at 8 decimals
            await this.creditIssue(gas, tick, r.address, credit, b.name, blockToParse, blockTime);
            credited++;
        }
        getLogger().info('GENESIS: airdrop bucket ' + b.name + ' complete - ' + credited + ' credits');
    },

    // sha256 over the canonical `name:hash:amount` line per bucket, newline-joined, in the
    // canonical (name-sorted) bucket order airdropBuckets returns. The line format is the
    // pinned wire form: changing it changes every armed pin, so it is fixed here and mirrored
    // in the arming runbook. An unpinned bucket contributes the literal 'unpinned', so an
    // unpinned set and a pinned one never collide.
    airdropSetHash(buckets){
        return crypto.createHash('sha256')
            .update(buckets.map(b => b.name + ':' + (b.hash || 'unpinned') + ':' + b.amount).join('\n'))
            .digest('hex');
    },

    // Zip GENESIS_AIRDROP_PATHS / _HASHES / _AMOUNTS into bucket descriptors, failing closed
    // on a missing or malformed amount (an unfunded bucket is a launch-cut mistake, not a
    // skippable row). Bucket name = uppercased file basename (xcp.csv -> XCP); it feeds the
    // synthetic tx hash, so two buckets must not share a basename.
    airdropBuckets(){
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
    },

    // sha256-pin check for one airdrop snapshot, mirroring verifyManifest: a null pin skips
    // (pre-pin dev/regtest), a mismatch halts the node, and a missing file always halts (an
    // armed bucket without its snapshot must never silently skip the whole allocation).
    verifyAirdropFile(bucket){
        if(!fs.existsSync(bucket.file))
            throw new Error('GENESIS FATAL: airdrop snapshot missing: ' + bucket.file);
        if(this.util.isNull(bucket.hash))
            return;
        let actual = crypto.createHash('sha256').update(fs.readFileSync(bucket.file)).digest('hex');
        if(actual !== String(bucket.hash).toLowerCase()){
            getLogger().error('GENESIS FATAL: airdrop snapshot hash mismatch for ' + bucket.file + ' (expected ' + bucket.hash + ', got ' + actual + '). Halting.');
            throw new Error('Genesis airdrop snapshot hash mismatch');
        }
    },

    // Read one snapshot CSV (address,quantity). Addresses never contain a comma, so the
    // LAST comma splits the fields (symmetric with loadRows). Duplicate addresses sum
    // (first-seen position wins for ordering, keeping the injection order pinned to the
    // hash-pinned file order); non-numeric or non-positive quantities are skipped + logged.
    // CP/DP quantities carry at most 8 decimals, matching the bcadd precision here.
    loadAirdropRows(file){
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
                getLogger().warn('GENESIS skip (bad airdrop quantity): ' + address + ',' + quantity);
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
    },

    // Pro-rata share: floor(amount * quantity / total) at the gas token's 8-decimal grid,
    // computed entirely in bignumber space (util.bcnum is decimal.js-backed). Flooring is
    // consensus-critical the same way bcmulfloor is: every node must derive the identical
    // credit, and rounding down keeps the bucket's minted sum <= its configured amount.
    prorate(amount, quantity, total){
        let share = this.util.bcnum(amount).times(this.util.bcnum(quantity)).div(this.util.bcnum(total));
        return share.times('100000000').floor().div('100000000').toFixed(8);
    },

    // Synthesize one airdrop credit: ISSUE format 2 from GAS carrying only MINT_SUPPLY and
    // TRANSFER_SUPPLY (VERSION|TICK|MAX_MINT|MINT_SUPPLY|TRANSFER_SUPPLY|...), so the token's
    // existing params are untouched (empty ISSUE fields inherit the current settings) and the
    // pipeline both mints the credit and lands it on the holder in a single action. The tx
    // hash digests (coin, bucket, address): addresses are deduped per bucket, so it is unique.
    async creditIssue(gas, tick, holder, credit, bucketName, blockToParse, blockTime){
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
    },

};

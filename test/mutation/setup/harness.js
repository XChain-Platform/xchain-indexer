/**
 * Mutation Testing Harness — engine, operator factories, and reporter
 *
 * Provides runtime mutation operators that apply sinon stubs to swap,
 * negate, or remove logic in the production code. Each mutation test
 * verifies the existing test suite would detect the introduced defect.
 */

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const sinon = require('sinon');
const fs = require('fs');
const path = require('path');
const mathjs = require('mathjs');
const { createMockIndexer, createBaseData, createTokenInfo } = require('../../fixtures/mocks');
const { getTestConfig } = require('../../fixtures/config');
const Utility = require('../../../src/utility.js');

// ─── MutationRegistry (singleton) ────────────────────────────────────────────

class MutationRegistry {
    constructor() {
        this.results = [];
    }

    record(entry) {
        this.results.push({
            id: entry.id || 'UNKNOWN',
            operator: entry.operator || '',
            target: entry.target || '',
            mutation: entry.mutation || '',
            file: entry.file || '',
            status: entry.status || 'survived',
            killedBy: entry.killedBy || '',
            description: entry.description || '',
        });
    }

    killed(id, opts) {
        this.record({ id, status: 'killed', ...opts });
    }

    survived(id, opts) {
        this.record({ id, status: 'survived', ...opts });
    }

    summary() {
        const total = this.results.length;
        const killed = this.results.filter(r => r.status === 'killed').length;
        const survived = this.results.filter(r => r.status === 'survived').length;
        const timeout = this.results.filter(r => r.status === 'timeout').length;
        const errors = this.results.filter(r => r.status === 'error').length;
        const score = total > 0 ? ((killed + timeout) / total * 100) : 0;
        return { total, killed, survived, timeout, errors, score: Math.round(score * 10) / 10 };
    }

    byOperator() {
        const map = {};
        for (const r of this.results) {
            if (!map[r.operator]) map[r.operator] = { total: 0, killed: 0 };
            map[r.operator].total++;
            if (r.status === 'killed' || r.status === 'timeout') map[r.operator].killed++;
        }
        for (const op of Object.keys(map)) {
            map[op].score = map[op].total > 0
                ? Math.round(map[op].killed / map[op].total * 1000) / 10
                : 0;
        }
        return map;
    }
}

const registry = new MutationRegistry();

// ─── Reporter ────────────────────────────────────────────────────────────────

const OPERATOR_NAMES = {
    AOR: 'Arithmetic Operator Replacement',
    ROR: 'Relational Operator Replacement',
    LCR: 'Logical Connector Replacement',
    UOI: 'Unary Operator Insertion/Deletion',
    SVR: 'Statement Value Replacement',
    SDL: 'Statement Deletion',
    BCR: 'Boundary Condition Replacement',
    SBR: 'String/Boolean Replacement',
    EMR: 'Empty Return Mutation',
    ACR: 'Array/Collection Replacement',
    PRM: 'Parameter Reorder Mutation',
    EHR: 'Error Handling Removal',
};

function printMutationReport() {
    const s = registry.summary();
    const byOp = registry.byOperator();
    const survived = registry.results.filter(r => r.status === 'survived');

    const lines = [
        '',
        '════════════════════════════════════════════════════════',
        '  MUTATION TEST REPORT — xchain-indexer',
        `  Run at: ${new Date().toISOString()}`,
        '════════════════════════════════════════════════════════',
        '',
        `  Mutation Score: ${s.score}%  (${s.killed}/${s.total} mutations killed)`,
        '',
        '  SUMMARY',
        '  ───────────────────────────────────────────────────',
        `  Total mutations:   ${String(s.total).padStart(3)}`,
        `  Killed:            ${String(s.killed).padStart(3)}  (${s.total ? Math.round(s.killed / s.total * 1000) / 10 : 0}%)`,
        `  Survived:          ${String(s.survived).padStart(3)}  (${s.total ? Math.round(s.survived / s.total * 1000) / 10 : 0}%)`,
        `  Timeout:           ${String(s.timeout).padStart(3)}  (${s.total ? Math.round(s.timeout / s.total * 1000) / 10 : 0}%)`,
        `  Errors:            ${String(s.errors).padStart(3)}  (${s.total ? Math.round(s.errors / s.total * 1000) / 10 : 0}%)`,
    ];

    if (survived.length > 0) {
        lines.push('');
        lines.push('  SURVIVED MUTATIONS (require attention)');
        lines.push('  ───────────────────────────────────────────────────');
        for (const m of survived) {
            lines.push(`  ${m.id.padEnd(9)} ${m.description.substring(0, 45).padEnd(45)} ${m.file}`);
        }
    }

    lines.push('');
    lines.push('  OPERATOR BREAKDOWN');
    lines.push('  ───────────────────────────────────────────────────');
    for (const [op, data] of Object.entries(byOp).sort((a, b) => a[0].localeCompare(b[0]))) {
        const name = (OPERATOR_NAMES[op] || op).padEnd(38);
        const counts = `${data.killed}/${data.total}`.padStart(6);
        lines.push(`  ${op}  ${name} ${counts}  ${data.score}%`);
    }
    lines.push('');
    lines.push('════════════════════════════════════════════════════════');

    console.log(lines.join('\n'));
}

function writeJsonReport() {
    const report = {
        timestamp: new Date().toISOString(),
        summary: registry.summary(),
        byOperator: registry.byOperator(),
        mutations: registry.results,
    };
    const outPath = path.join(__dirname, '..', 'mutation-report.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
}

function setupReportHook() {
    after(function () {
        printMutationReport();
        if (process.env.MUTATION_REPORT === '1') {
            writeJsonReport();
        }
    });
}

// ─── Mutation Operator Factories ─────────────────────────────────────────────
//
// Each factory takes a target instance (util, handler, db) and returns
// a sinon stub. Call sinon.restore() in afterEach to clean up.

const operators = {

    // ── AOR: Arithmetic Operator Replacement ─────────────────────────────

    AOR: {
        /** bcadd uses subtract instead of add */
        addToSub(util) {
            const orig = Utility.prototype.bcadd;
            return sinon.stub(util, 'bcadd').callsFake(function (numA, numB, decimals) {
                let a = (!this.isNull(numA)) ? numA : 0;
                let b = (!this.isNull(numB)) ? numB : 0;
                let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
                return this.bcnum(mathjs.format(mathjs.subtract(mathjs.bignumber(a), mathjs.bignumber(b)), { notation: 'fixed', precision: d }));
            });
        },

        /** bcsub uses add instead of subtract */
        subToAdd(util) {
            return sinon.stub(util, 'bcsub').callsFake(function (numA, numB, decimals) {
                let a = (!this.isNull(numA)) ? numA : 0;
                let b = (!this.isNull(numB)) ? numB : 0;
                let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
                return this.bcnum(mathjs.format(mathjs.add(mathjs.bignumber(a), mathjs.bignumber(b)), { notation: 'fixed', precision: d }));
            });
        },

        /** bcmul uses divide instead of multiply */
        mulToDiv(util) {
            return sinon.stub(util, 'bcmul').callsFake(function (numA, numB, decimals) {
                let a = (!this.isNull(numA)) ? numA : 0;
                let b = (!this.isNull(numB)) ? numB : 0;
                let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
                if (String(b) === '0' || b === 0) return mathjs.bignumber(0);
                return this.bcnum(mathjs.format(mathjs.divide(mathjs.bignumber(a), mathjs.bignumber(b)), { notation: 'fixed', precision: d }));
            });
        },

        /** bcdiv uses multiply instead of divide */
        divToMul(util) {
            return sinon.stub(util, 'bcdiv').callsFake(function (numA, numB, decimals) {
                let a = (!this.isNull(numA)) ? numA : 0;
                let b = (!this.isNull(numB)) ? numB : 0;
                let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
                return this.bcnum(mathjs.format(mathjs.multiply(mathjs.bignumber(a), mathjs.bignumber(b)), { notation: 'fixed', precision: d }));
            });
        },
    },

    // ── ROR: Relational Operator Replacement ─────────────────────────────

    ROR: {
        /** bcgt uses mathjs.smaller (> becomes <) */
        gtToLt(util) {
            return sinon.stub(util, 'bcgt').callsFake(function (numA, numB) {
                return mathjs.smaller(this.bcnum(numA), this.bcnum(numB));
            });
        },

        /** bclt uses mathjs.larger (< becomes >) */
        ltToGt(util) {
            return sinon.stub(util, 'bclt').callsFake(function (numA, numB) {
                return mathjs.larger(this.bcnum(numA), this.bcnum(numB));
            });
        },

        /** bcgte uses mathjs.smallerEq (>= becomes <=) */
        gteToLte(util) {
            return sinon.stub(util, 'bcgte').callsFake(function (numA, numB) {
                return mathjs.smallerEq(this.bcnum(numA), this.bcnum(numB));
            });
        },

        /** bclte uses mathjs.largerEq (<= becomes >=) */
        lteToGte(util) {
            return sinon.stub(util, 'bclte').callsFake(function (numA, numB) {
                return mathjs.largerEq(this.bcnum(numA), this.bcnum(numB));
            });
        },

        /** bcgt uses mathjs.largerEq (> becomes >=) */
        gtToGte(util) {
            return sinon.stub(util, 'bcgt').callsFake(function (numA, numB) {
                return mathjs.largerEq(this.bcnum(numA), this.bcnum(numB));
            });
        },

        /** bclt uses mathjs.smallerEq (< becomes <=) */
        ltToLte(util) {
            return sinon.stub(util, 'bclt').callsFake(function (numA, numB) {
                return mathjs.smallerEq(this.bcnum(numA), this.bcnum(numB));
            });
        },
    },

    // ── UOI: Unary Operator Insertion/Deletion ───────────────────────────

    UOI: {
        /** isNull returns negated result */
        negateIsNull(util) {
            const orig = util.isNull.bind(util);
            return sinon.stub(util, 'isNull').callsFake(v => !orig(v));
        },

        /** isNumeric returns negated result */
        negateIsNumeric(util) {
            const orig = util.isNumeric.bind(util);
            return sinon.stub(util, 'isNumeric').callsFake(v => !orig(v));
        },

        /** isCryptoAddress returns negated result */
        negateIsCryptoAddress(util) {
            const orig = util.isCryptoAddress.bind(util);
            return sinon.stub(util, 'isCryptoAddress').callsFake(v => !orig(v));
        },

        /** isValidAmountFormat returns negated result */
        negateIsValidAmountFormat(util) {
            const orig = util.isValidAmountFormat.bind(util);
            return sinon.stub(util, 'isValidAmountFormat').callsFake((d, a) => !orig(d, a));
        },

        /** hasBalance returns negated result */
        negateHasBalance(util) {
            const orig = util.hasBalance.bind(util);
            return sinon.stub(util, 'hasBalance').callsFake((b, t, a) => !orig(b, t, a));
        },

        /** isValidLockValue returns negated result */
        negateIsValidLockValue(util) {
            const orig = util.isValidLockValue.bind(util);
            return sinon.stub(util, 'isValidLockValue').callsFake(v => !orig(v));
        },
    },

    // ── SVR: Statement Value Replacement ─────────────────────────────────

    SVR: {
        /** isValidAmountFormat always returns true */
        amountFormatAlwaysTrue(util) {
            return sinon.stub(util, 'isValidAmountFormat').returns(true);
        },

        /** isCryptoAddress always returns true */
        cryptoAddressAlwaysTrue(util) {
            return sinon.stub(util, 'isCryptoAddress').returns(true);
        },

        /** hasBalance always returns true */
        hasBalanceAlwaysTrue(util) {
            return sinon.stub(util, 'hasBalance').returns(true);
        },

        /** isValidLock always returns true */
        lockAlwaysTrue(util) {
            return sinon.stub(util, 'isValidLock').returns(true);
        },
    },

    // ── SDL: Statement Deletion ──────────────────────────────────────────

    SDL: {
        /** Bypass TICK existence check: getTokenInfo always returns a token */
        skipTokenCheck(db, tokenInfo) {
            return sinon.stub(db, 'getTokenInfo').resolves(tokenInfo || createTokenInfo());
        },

        /** Bypass balance check: hasBalance always returns true */
        skipBalanceCheck(util) {
            return sinon.stub(util, 'hasBalance').returns(true);
        },

        /** Bypass sleeping check: isActionAllowed always returns true */
        skipSleepCheck(db) {
            return sinon.stub(db, 'isActionAllowed').resolves(true);
        },

        /** Bypass amount format check */
        skipAmountFormat(util) {
            return sinon.stub(util, 'isValidAmountFormat').returns(true);
        },

        /** Bypass address format check */
        skipAddressFormat(util) {
            return sinon.stub(util, 'isCryptoAddress').returns(true);
        },
    },

    // ── BCR: Boundary Condition Replacement ──────────────────────────────

    BCR: {
        /** hasBalance uses larger instead of largerEq (exact match fails) */
        hasBalanceStrictGt(util) {
            return sinon.stub(util, 'hasBalance').callsFake(function (balances, tick_id, amount) {
                let balance = (!this.isNull(balances[tick_id])) ? balances[tick_id] : 0;
                // Use strict > instead of >= (boundary mutation)
                return mathjs.larger(this.bcnum(balance), this.bcnum(amount));
            });
        },

        /** isCryptoAddress: len >= 26 becomes len > 26 */
        cryptoAddrGt26(util) {
            return sinon.stub(util, 'isCryptoAddress').callsFake(function (address) {
                let len = String(address).length;
                if (len > 26 && len <= 35) return true;   // > instead of >=
                if (len == 42) return true;
                return false;
            });
        },

        /** isCryptoAddress: len <= 35 becomes len < 35 */
        cryptoAddrLt35(util) {
            return sinon.stub(util, 'isCryptoAddress').callsFake(function (address) {
                let len = String(address).length;
                if (len >= 26 && len < 35) return true;   // < instead of <=
                if (len == 42) return true;
                return false;
            });
        },

        /** isCryptoAddress: len == 42 becomes len != 42 (Segwit rejected) */
        cryptoAddrNot42(util) {
            return sinon.stub(util, 'isCryptoAddress').callsFake(function (address) {
                let len = String(address).length;
                if (len >= 26 && len <= 35) return true;
                // Segwit check removed
                return false;
            });
        },

        /** bcgte uses mathjs.larger (>= becomes >) */
        gteToGt(util) {
            return sinon.stub(util, 'bcgte').callsFake(function (numA, numB) {
                return mathjs.larger(this.bcnum(numA), this.bcnum(numB));
            });
        },

        /** bclte uses mathjs.smaller (<= becomes <) */
        lteToLt(util) {
            return sinon.stub(util, 'bclte').callsFake(function (numA, numB) {
                return mathjs.smaller(this.bcnum(numA), this.bcnum(numB));
            });
        },

        /** isValidFiatFormat: sats.length > decimals becomes >= */
        fiatFormatGte(util) {
            return sinon.stub(util, 'isValidFiatFormat').callsFake(function (decimals, amount) {
                let valid = this.isValidAmountFormat(decimals, amount);
                if (valid) {
                    let [int, sats] = String(amount).split('.');
                    if (!this.isNull(sats) && String(sats).length >= decimals)  // >= instead of >
                        valid = false;
                }
                return valid;
            });
        },
    },

    // ── SBR: String/Boolean Replacement ──────────────────────────────────

    SBR: {
        /** isValidLockValue accepts only [1] instead of [0,1] */
        lockValueOnlyOne(util) {
            return sinon.stub(util, 'isValidLockValue').callsFake(function (value) {
                let type = typeof value;
                let valid = [1]; // Removed 0 from valid
                if (type == 'string' && this.isNumeric(value)) value = parseInt(value);
                if (valid.indexOf(value) != -1) return true;
                return false;
            });
        },

        /** isNull does not treat '' as null */
        isNullNoEmpty(util) {
            return sinon.stub(util, 'isNull').callsFake(function (value) {
                return (value === null || value === undefined); // removed value===''
            });
        },

        /** isValidAmountFormat: divisible flipped for DECIMALS=0 */
        amountDivisibleFlip(util) {
            return sinon.stub(util, 'isValidAmountFormat').callsFake(function (decimals, amount) {
                if (amount !== null && amount !== undefined && typeof amount === 'object' && this.safeToString(amount) === null)
                    return false;
                if (String(amount).startsWith('-'))
                    return false;
                let divisible = (parseInt(decimals) == 0) ? true : false; // FLIPPED
                let [int, sats] = String(amount).split('.');
                if (!divisible && this.isNumeric(int) && int == amount)
                    return true;
                if (divisible && this.isNumeric(int) && (this.isNull(sats) || this.isNumeric(sats)))
                    return true;
                return false;
            });
        },
    },

    // ── EMR: Empty Return Mutation ───────────────────────────────────────

    EMR: {
        /** bcadd returns null */
        bcaddNull(util) {
            return sinon.stub(util, 'bcadd').returns(null);
        },

        /** bcsub returns null */
        bcsubNull(util) {
            return sinon.stub(util, 'bcsub').returns(null);
        },

        /** bcnum returns null */
        bcnumNull(util) {
            return sinon.stub(util, 'bcnum').returns(null);
        },

        /** hasBalance returns null (falsy) */
        hasBalanceNull(util) {
            return sinon.stub(util, 'hasBalance').returns(null);
        },

        /** isValidAmountFormat returns null (falsy) */
        amountFormatNull(util) {
            return sinon.stub(util, 'isValidAmountFormat').returns(null);
        },

        /** isCryptoAddress returns null (falsy) */
        cryptoAddressNull(util) {
            return sinon.stub(util, 'isCryptoAddress').returns(null);
        },
    },

    // ── ACR: Array/Collection Replacement ────────────────────────────────

    ACR: {
        /** consolidateLedgerRecords destructures [amount, tick, address] instead of [tick, amount, address] */
        consolidateSwapTickAmount(util) {
            return sinon.stub(util, 'consolidateLedgerRecords').callsFake(function (records) {
                let arr = [], data = [];
                for (let idx in records) {
                    let [amount, tick, address] = records[idx]; // SWAPPED tick and amount
                    let key = tick + '\0' + address;
                    arr[key] = (arr[key]) ? this.bcadd(arr[key], amount, 18) : amount;
                }
                for (let key in arr) {
                    let amount = arr[key];
                    let [tick, address] = String(key).split('\0');
                    data.push([tick, amount, address]);
                }
                return data;
            });
        },

        /** consolidateLedgerRecords uses wrong key: address + '\0' + tick */
        consolidateSwapKey(util) {
            return sinon.stub(util, 'consolidateLedgerRecords').callsFake(function (records) {
                let arr = [], data = [];
                for (let idx in records) {
                    let [tick, amount, address] = records[idx];
                    let key = address + '\0' + tick; // SWAPPED key components
                    arr[key] = (arr[key]) ? this.bcadd(arr[key], amount, 18) : amount;
                }
                for (let key in arr) {
                    let amount = arr[key];
                    let [tick, address] = String(key).split('\0'); // Will parse wrong
                    data.push([tick, amount, address]);
                }
                return data;
            });
        },
    },

    // ── PRM: Parameter Reorder Mutation ──────────────────────────────────

    PRM: {
        /** bcsub(a, b) becomes bcsub(b, a) */
        bcsubSwapArgs(util) {
            return sinon.stub(util, 'bcsub').callsFake(function (numA, numB, decimals) {
                let a = (!this.isNull(numA)) ? numA : 0;
                let b = (!this.isNull(numB)) ? numB : 0;
                let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
                // SWAPPED: subtract b from a → subtract a from b
                return this.bcnum(mathjs.format(mathjs.subtract(mathjs.bignumber(b), mathjs.bignumber(a)), { notation: 'fixed', precision: d }));
            });
        },

        /** bcdiv(a, b) becomes bcdiv(b, a) */
        bcdivSwapArgs(util) {
            return sinon.stub(util, 'bcdiv').callsFake(function (numA, numB, decimals) {
                let a = (!this.isNull(numA)) ? numA : 0;
                let b = (!this.isNull(numB)) ? numB : 0;
                let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
                if (String(a) === '0' || a === 0) return mathjs.bignumber(0); // zero check on swapped arg
                // SWAPPED: divide a by b → divide b by a
                return this.bcnum(mathjs.format(mathjs.divide(mathjs.bignumber(b), mathjs.bignumber(a)), { notation: 'fixed', precision: d }));
            });
        },
    },

    // ── EHR: Error Handling Removal ──────────────────────────────────────

    EHR: {
        /** bcdiv removes divide-by-zero guard */
        bcdivNoZeroGuard(util) {
            return sinon.stub(util, 'bcdiv').callsFake(function (numA, numB, decimals) {
                let a = (!this.isNull(numA)) ? numA : 0;
                let b = (!this.isNull(numB)) ? numB : 0;
                let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
                // NO zero check — will throw on divide by zero
                return this.bcnum(mathjs.format(mathjs.divide(mathjs.bignumber(a), mathjs.bignumber(b)), { notation: 'fixed', precision: d }));
            });
        },

        /** throwError returns undefined instead of throwing */
        throwErrorSilent(util) {
            return sinon.stub(util, 'throwError').returns(undefined);
        },
    },

    // ── LCR: Logical Connector Replacement ───────────────────────────────
    // Simulated by making guard predicates return values that bypass checks

    LCR: {
        /** isValidAmountFormat always true — simulates && to || on negative branch */
        amountFormatBypass(util) {
            return sinon.stub(util, 'isValidAmountFormat').returns(true);
        },

        /** isCryptoAddress always true — simulates && to || on address branch */
        addressFormatBypass(util) {
            return sinon.stub(util, 'isCryptoAddress').returns(true);
        },

        /** hasBalance always true — simulates && to || on balance branch */
        balanceBypass(util) {
            return sinon.stub(util, 'hasBalance').returns(true);
        },
    },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build an actionsCtx object for constructing action handlers.
 */
function makeActionsCtx(indexer) {
    return {
        config: indexer.config,
        util: indexer.util,
        mapper: indexer.mapper,
        decoderDb: indexer.decoderDb,
        indexerDb: indexer.indexerDb,
        protocolChanges: {
            isDefined: sinon.stub().returns(true),
            isEnabled: sinon.stub().resolves(true),
        },
        processAction: sinon.stub().resolves(),
    };
}

module.exports = {
    // Registry
    registry,

    // Operators
    operators,

    // Reporter
    printMutationReport,
    writeJsonReport,
    setupReportHook,

    // Fixtures (re-exports)
    createMockIndexer,
    createBaseData,
    createTokenInfo,
    getTestConfig,
    Utility,
    makeActionsCtx,

    // Libraries
    mathjs,
    sinon,
};

'use strict';

function sumMeteredFees(executions) {
    return executions.reduce(function (sum, row) {
        return sum + Number(row.metered_fee);
    }, 0);
}

module.exports = { sumMeteredFees };

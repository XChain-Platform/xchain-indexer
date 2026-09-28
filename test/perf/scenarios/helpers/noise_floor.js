'use strict';

function shouldTrustRatioGate(youngValue, floorMs) {
    return youngValue !== null && Number.isFinite(youngValue) && youngValue >= floorMs;
}

module.exports = { shouldTrustRatioGate };

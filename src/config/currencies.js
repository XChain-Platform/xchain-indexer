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
 * The accepted coin and fiat currency lists, the first keys src/config.js's
 * getConfig() lays down. config['FIATS'] keys are the on-chain arbiter for
 * the price lanes; xchain-hub's constants_conformance suite compares them by
 * executing getConfig(), so they are free to live here rather than in the
 * text of src/config.js.
 ********************************************************************/

'use strict';

// Built fresh on every call, as it was inline in getConfig(), so one caller
// mutating its config cannot leak into the next.
function applyCurrencies(config){
    // Define list of acceptable COIN networks
    config['COINS'] = ['BTC', 'LTC', 'DOGE'];

    // Define list of acceptable FIAT currencies
    config['FIATS']        = {};
    config['FIATS']['USD'] = 'US Dollar';
    config['FIATS']['CAD'] = 'Canadian Dollar';
    config['FIATS']['AUD'] = 'Australian Dollar';
    config['FIATS']['MXN'] = 'Mexican Peso';
    config['FIATS']['GBP'] = 'Great Britain Pound';
    config['FIATS']['JPY'] = 'Japanese Yen';
    config['FIATS']['CNY'] = 'Chinese Yuan';
    config['FIATS']['CHF'] = 'Swiss Franc';
    config['FIATS']['BRL'] = 'Brazilian Real';
    config['FIATS']['INR'] = 'Indian Rupee';
    config['FIATS']['EUR'] = 'Euro';
    config['FIATS']['KRW'] = 'South Korean Won';
}

module.exports = { applyCurrencies };

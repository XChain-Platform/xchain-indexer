/* XChain Indexer Utility Functions */

const crypto = require('crypto');
const mathjs = require('mathjs');

module.exports = {

    // Handle sleeping for a given number of milliseconds
    sleep: function(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    },

    // Throw an error and log to console
    throwError: function(error){
        console.log(error);
        throw new Error(error);
    },

    // Get a SHA256 hash of a given data object
    getDataHash: function(data){
        let obj  = Object.assign({}, data); // Convert data to object if not already
        let json = JSON.stringify(obj);     // Convert object to JSON string
        let hash = crypto.createHash('sha256').update(json).digest('hex');
        return hash;
    },

    // Start a debug timer
    startTimer: function(){
        let now = Date.now();
        return now;
    },

    // Log a timer using a given name
    logTimer: function(timer, timeName){
        let now = Date.now();
        let ms  = now - timer;
        var timeString = this.millisecondsToTimeString(ms);
        var niceString = (timeName!=null) ? timeName : 'Time';
        niceString += "\t: " + ms + 'ms';
        if(timeString!='')
            niceString += ' (' + timeString + ')';
        console.log(niceString);
    },

    // Create nice human readable time string based on miliiseconds
    millisecondsToTimeString: function(ms){
        var milliseconds = Math.floor((ms % 1000) / 100),
            seconds      = Math.floor((ms / 1000) % 60),
            minutes      = Math.floor((ms / (1000 * 60)) % 60),
            hours        = Math.floor((ms / (1000 * 60 * 60)) % 24),
            days         = Math.floor((ms / (1000 * 60 * 60 * 24)) % 365);
        // Display time in XX format
        hours   = (hours < 10)   ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;
        // Build out time string to nicely display time
        var str = '';
        if(days    > 0) str += days + 'd ';
        if(hours   > 0) str += hours + 'h ';
        if(minutes > 0) str += minutes + 'm ';
        if(seconds > 0) str += seconds + '.' + milliseconds + 's';
        return str;
    },

    // Determine if a value is numeric
    isNumeric: function(value){
        return !isNaN(parseFloat(value)) && isFinite(value);
    },

    // Determine if value is floating point
    isFloat: function(value){
        return value === +value && value !== (value|0);
    },

    // Determine if value is integer
    isInteger: function(value){
        return value === +value && value === (value|0);
    },

    // Determine if value is null or undefined
    isNull: function(value){
        return (value === null || value === undefined);
    },

    // Handle determining if first param is TICK or VERSION
    isLegacyActionFormat: function(params){
        version = params[0]; // VERSION or TICK
        // VERSION will max out at 99 (2 chars)
        if(String(version).length>2)
            return true;
        // VERSION should be NULL or integer
        if(typeof version === 'string' && !this.isNumeric(version))
            return true;
        // Add more rules here if ppl keep using old format
        return false;
    },

    // Handle returning integer format version
    getFormatVersion: function(format){
        let type = typeof format;
        if(type=='number' && this.isInteger(format))
            return format;
        // Default to format 0 if none is given
        if(type=='undefined' || (type=='string' && format==''))
            return 0;
        // Strip out any quotes and double-quotes
        if(type=='string')
            format = format.replace(/\"|\'/g,'');
        // Convert any numeric strings to integers
        if(this.isNumeric(format) && !this.isFloat(format))
            return parseInt(format);
        // Return NULL if not able to identify format version
        return null;
    },

    // Handle setting ACTION PARAMS based on format VERSION (updates ACTION transaction data object)
    setActionParams: function(data, params, format){
        let fields = String(format).split('|');
        for(idx in fields){
            let field = fields[idx];
            let value = null;
            if(typeof params[idx] !== 'undefined')
                value = String(params[idx]).trim();
            data[field] = value;
        }
        return data;
    },

    // Handle subtracting 2 big numbers
    bcsub: function(a, b, decimals){
        let precision = (decimals) ? decimals : 0;
        return result = mathjs.format(mathjs.subtract(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: precision});
    },

    // Handle adding 2 big numbers
    bcadd: function(a, b, decimals){
        let precision = (decimals) ? decimals : 0;
        return result = mathjs.format(mathjs.add(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: precision});
    }

}
/* XChain Indexer Utility Class */

module.exports = {

    // Handle sleeping for a given number of milliseconds
    sleep: function(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    },

    // Handle throwing an error and logging to console
    throwError: function(error){
        console.log(error);
        throw new Error(error);
    }

}
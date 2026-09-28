function resolveXChainVM(){
    try { return { XChainVM: require('xchain-vm'), available: true }; }
    catch(e) { return { XChainVM: null, available: false }; }
}

module.exports = { resolveXChainVM };

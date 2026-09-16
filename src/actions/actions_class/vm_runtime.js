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
 * XChain Indexer - Actions class: VM runtime boot gates
 *
 * The two fail-closed checks the Actions constructor runs before any contract handler is
 * wired up (VM loadable, engine on the consensus pin), and the pure diagnostics that name
 * a binding/platform mismatch in the boot refusal. The require('xchain-vm') itself stays
 * in actions/index.js, which hands the loaded module (or its load error) to these gates.
 *
 ********************************************************************/

const fs   = require('fs');
const path = require('path');

// Object-format sniff for a native binding, from its first bytes. Used only to NAME the
// mismatch in the boot refusal: a binding built for another OS is the recurring cause
// (an NFS-shared node_modules built on Linux, mounted on a Darwin host), and "is ELF
// (Linux), host is darwin" is the sentence that ends the investigation. Pure so the
// refusal text is testable without a foreign binding on disk.
function bindingObjectFormat(head){
    if(!head || head.length < 4)
        return null;
    if(head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46)
        return 'ELF (Linux)';
    if(head[0] === 0x4d && head[1] === 0x5a)
        return 'PE (Windows)';
    const be = (head[0] << 24 >>> 0) + (head[1] << 16) + (head[2] << 8) + head[3];
    if(be === 0xfeedface || be === 0xfeedfacf || be === 0xcefaedfe || be === 0xcffaedfe)
        return 'Mach-O (macOS)';
    if(be === 0xcafebabe || be === 0xbebafeca)
        return 'Mach-O universal (macOS)';
    return null;
}

// The .node path a loader error names, when it names one (dlopen errors do).
function bindingPathFromError(loadError){
    const msg = loadError && loadError.message ? String(loadError.message) : '';
    const m   = /([^\s'"()]+\.node)/.exec(msg);
    return m ? m[1] : null;
}

// Everything the refusal needs about THIS host and the binding it could not load.
// Best-effort and never throwing: a diagnostic must not replace the failure it describes.
//
// The loader error's own path wins over anything resolved here. More than one isolated-vm
// copy can sit in a tree (this indexer's node_modules and xchain-vm's own), only one of
// which the failed load actually touched, so sniffing a resolved copy can name a binding
// that had nothing to do with the failure. Resolution is the fallback for the case where
// the error carries no path, and it is anchored on xchain-vm's own tree first because that
// is the package whose require() failed.
function collectVmRuntimeEnv(loadError){
    const env = {
        platform:    process.platform,
        arch:        process.arch,
        nodeVersion: process.version,
        modules:     process.versions.modules,
        bindingPath: null,
        bindingFormat: null
    };

    const sniff = (candidate) => {
        try {
            if(!fs.existsSync(candidate))
                return false;
            env.bindingPath = candidate;
            const fd   = fs.openSync(candidate, 'r');
            const head = Buffer.alloc(4);
            try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
            env.bindingFormat = bindingObjectFormat(head);
            return true;
        } catch(e) {
            return false;
        }
    };

    const named = bindingPathFromError(loadError);
    if(named && sniff(named))
        return env;

    try {
        const roots = [];
        try {
            roots.push(path.dirname(require.resolve('xchain-vm/package.json')));
        } catch(e) {
            // Not installed at all: fall through to this module's own resolution paths.
        }
        for(const from of roots.concat([__dirname])){
            let ivRoot;
            try { ivRoot = path.dirname(require.resolve('isolated-vm/package.json', { paths: [from] })); }
            catch(e) { continue; }
            const found = ['out/isolated_vm.node', 'build/Release/isolated_vm.node']
                .some((rel) => sniff(path.join(ivRoot, rel)));
            if(found)
                break;
        }
    } catch(e) {
        // No isolated-vm on disk at all, or an unreadable one: the loader error still
        // carries the primary fact, and the message degrades to host details only.
    }
    return env;
}

// The boot-refusal text. Names WHAT could not load, on WHICH host, and (when the binding
// is on disk) the platform mismatch itself, then the remedy.
function describeVmLoadFailure(loadError, env){
    const e    = loadError || {};
    const code = e.code ? String(e.code) : 'unknown';
    const msg  = String(e.message || e).split('\n')[0];
    const host = `host ${env.platform}-${env.arch}, Node ${env.nodeVersion} (modules ABI ${env.modules})`;

    let cause;
    if(code === 'MODULE_NOT_FOUND'){
        cause = 'the xchain-vm package is not installed for this indexer; run npm install here';
    } else if(env.bindingPath && env.bindingFormat && !env.bindingFormat.startsWith(hostObjectFormatPrefix(env.platform))){
        cause = `the isolated-vm binding ${env.bindingPath} is ${env.bindingFormat}, which cannot load on ` +
            `${env.platform}-${env.arch}: node_modules was built for another platform (a shared or NFS-mounted ` +
            'node_modules is the usual cause). Reinstall this indexer\'s dependencies on this host';
    } else if(env.bindingPath){
        cause = `the isolated-vm binding ${env.bindingPath} exists but did not load on ${env.platform}-${env.arch}; ` +
            'rebuild or reinstall it on this host';
    } else {
        cause = 'the isolated-vm binding could not be found or loaded; reinstall this indexer\'s dependencies on this host';
    }

    return 'VM RUNTIME UNAVAILABLE: xchain-vm could not be loaded, so this indexer can never execute a ' +
        'contract block. REFUSING TO START rather than serving a height that stops at the first contract ' +
        `block. ${host}. Cause: ${cause}. Loader error (${code}): ${msg}`;
}

// The object format a binding must have to load on this platform.
function hostObjectFormatPrefix(platform){
    if(platform === 'darwin') return 'Mach-O';
    if(platform === 'win32')  return 'PE';
    return 'ELF';
}

// Boot gate: an indexer that cannot load the VM must refuse AT BOOT, not park later.
//
// Warning at require() time and continuing with this.vm = null is not enough. The process
// then starts, answers health and RPC normally, and only stops at the FIRST CONTRACT BLOCK,
// where deploy/execute raise EXECUTOR_UNAVAILABLE and the block loop halts (stallReason
// vm_executor_unavailable) rather than fabricate a result and fork. That halt is correct;
// reaching it is not. The park height is data-dependent (the first contract block, not the
// tip), so the node can serve a stale height hundreds of blocks behind the decoder before
// anything looks wrong, and the visible symptom (503 at a frozen height) names neither the
// binding nor the platform mismatch that caused it. Measured 2026-09-04: indexer 0 answered
// 503 at height 593 against a decoder at 4006, with a Linux-built isolated_vm.node on a
// Darwin host.
//
// Refusing here aborts Actions construction, so api.js traps the start() rejection and exits
// 1 with the mismatch named, the same fail-closed shape as assertConsensusRuntime. No bypass
// flag: an indexer without a VM cannot validate this chain at all, so there is no workflow an
// override would serve.
function assertVmRuntimeLoadable(vmModule, loadError, env){
    if(vmModule)
        return;
    throw new Error(describeVmLoadFailure(loadError, env || collectVmRuntimeEnv(loadError)));
}

// Consensus-runtime gate: refuse to run contracts on an off-pin JS engine.
//
// The VM produces some contract-observable bytes (native V8 error text, ICU-backed
// locale primitives) that are NOT spec-mandated and have changed across engine
// versions. A contract can route such a value into hashed state, so a validator on
// an off-pin V8/ICU commits different bytes for the same contract: divergent
// contract_hash, chain fork. xchain-vm/src/consensus_runtime.js pins the engine for
// exactly that reason and requires every validator to be gated against the pin.
//
// The gate throws here rather than warning, and it lives here rather than in the CI
// test, because CI runs on a build host and not on the validator, so it cannot protect
// a running node: both manifests admit every Node 22 release, and any of them could
// deploy and execute contracts off-pin. Throwing here aborts Actions construction before a single
// contract handler is wired up, so the process exits loudly (api.js traps the start()
// rejection and exits 1) instead of forking the chain. Halting over forking is the
// same call deploy.js/execute.js (EXECUTOR_UNAVAILABLE) and consensus/fault_guard.js already make.
//
// No bypass flag: the sanctioned way to move the fleet to a new engine is to re-pin
// consensus-runtime.js, regenerate the determinism manifests and coordinate an atomic
// fleet activation (consensus-runtime.js, "RE-PINNING IS A CONSENSUS EVENT"), after
// which this check passes on the new engine. An override would cover no workflow the
// re-pin does not, while reintroducing the exact fail-open under one env var.
//
// The comparison is engine-level (v8/icu/unicode/cldr/modules), never the Node version
// string, so a Node patch carrying the same engine does not trip it. Pure and
// dependency-injected so the gate itself is unit-testable.
function assertConsensusRuntime(vmModule){
    if(!vmModule || typeof vmModule.checkConsensusRuntime !== 'function')
        return;
    const rt = vmModule.checkConsensusRuntime();
    if(!rt.ok)
        throw new Error(vmModule.describeRuntimeMismatch(rt));
}

module.exports = {
    bindingObjectFormat,
    bindingPathFromError,
    collectVmRuntimeEnv,
    describeVmLoadFailure,
    assertVmRuntimeLoadable,
    assertConsensusRuntime
};

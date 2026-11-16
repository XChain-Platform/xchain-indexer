// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const crypto = require('crypto');
const sinon = require('sinon');

const META_FIELDS = [
    'name', 'type', 'title', 'memo', 'gateTicker', 'encryptionMethod',
    'keyHash', 'gateMinAmount', 'compression',
];

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function wireValue(meta, key, fallback) {
    return String(hasOwn(meta, key) ? meta[key] : fallback);
}

function trimTrailingEmpty(params) {
    while (params[params.length - 1] === '') params.pop();
    return params;
}

function buildMultipartPieces(partBuffers, meta = {}) {
    const digestBuffers = partBuffers.map(part =>
        crypto.createHash('sha256').update(part).digest());
    const fileHash = crypto.createHash('sha256')
        .update(Buffer.concat(digestBuffers)).digest('hex');
    const totalParts = partBuffers.length;
    const totalBytes = partBuffers.reduce((sum, part) => sum + part.length, 0);
    const wireFileHash = wireValue(meta, 'fileHash', fileHash);
    const manifestParams = ['1', wireFileHash,
        wireValue(meta, 'totalParts', totalParts),
        wireValue(meta, 'totalBytes', totalBytes),
        ...META_FIELDS.map(field => hasOwn(meta, field) ? String(meta[field]) : ''),
    ];
    trimTrailingEmpty(manifestParams);
    const manifest = {
        params: manifestParams,
        command: ['FILE', ...manifestParams].join('|'),
    };
    const parts = partBuffers.map((rawData, partIndex) => {
        const params = ['2', wireFileHash, String(partIndex)];
        return {
            partIndex,
            rawData,
            digest: digestBuffers[partIndex].toString('hex'),
            params,
            command: ['FILE', ...params].join('|'),
        };
    });
    return { fileHash, totalParts, totalBytes, manifest, parts };
}

function contextValue(ctx, lower, upper) {
    return hasOwn(ctx, lower) ? ctx[lower] : ctx[upper];
}

function copyContextKey(data, ctx, lower, upper) {
    if (hasOwn(ctx, lower) || hasOwn(ctx, upper))
        data[upper] = contextValue(ctx, lower, upper);
}

function multipartActionData(piece, ctx = {}) {
    const data = {
        ACTION: 'FILE',
        FORMAT: Number(piece.params[0]),
        TX_DATA: piece.command,
        SOURCE: contextValue(ctx, 'source', 'SOURCE'),
        BLOCK_INDEX: contextValue(ctx, 'blockIndex', 'BLOCK_INDEX'),
        ACTION_INDEX: contextValue(ctx, 'actionIndex', 'ACTION_INDEX'),
    };
    if (hasOwn(piece, 'rawData')) data['RAW_DATA'] = piece.rawData;
    else if (hasOwn(ctx, 'rawData')) data['RAW_DATA'] = ctx.rawData;
    copyContextKey(data, ctx, 'batchPosition', 'BATCH_POSITION');
    copyContextKey(data, ctx, 'siblingActions', 'SIBLING_ACTIONS');
    return data;
}

function withMultipartFlag(actionsCtx, active) {
    const stub = sinon.stub().callsFake(async name =>
        name === 'FILE_MULTIPART' ? active : true);
    actionsCtx.protocolChanges.isEnabled = stub;
    return stub;
}

module.exports = { buildMultipartPieces, multipartActionData, withMultipartFlag };

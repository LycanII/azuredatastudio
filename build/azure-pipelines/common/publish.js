/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs");
const crypto = require("crypto");
const azure = require("azure-storage");
const mime = require("mime");
const minimist = require("minimist");
const documentdb_1 = require("documentdb");
// {{SQL CARBON EDIT}}
if (process.argv.length < 9) {
    console.error('Usage: node publish.js <product_quality> <platform> <file_type> <file_name> <version> <is_update> <file> [commit_id]');
    process.exit(-1);
}
function hashStream(hashName, stream) {
    return new Promise((c, e) => {
        const shasum = crypto.createHash(hashName);
        stream
            .on('data', shasum.update.bind(shasum))
            .on('error', e)
            .on('close', () => c(shasum.digest('hex')));
    });
}
function createDefaultConfig(quality) {
    return {
        id: quality,
        frozen: false
    };
}
function getConfig(quality) {
    console.log(`Getting config for quality ${quality}`);
    const client = new documentdb_1.DocumentClient(process.env['AZURE_DOCUMENTDB_ENDPOINT'], { masterKey: process.env['AZURE_DOCUMENTDB_MASTERKEY'] });
    const collection = 'dbs/builds/colls/config';
    const query = {
        query: `SELECT TOP 1 * FROM c WHERE c.id = @quality`,
        parameters: [
            { name: '@quality', value: quality }
        ]
    };
    return retry(() => new Promise((c, e) => {
        client.queryDocuments(collection, query, { enableCrossPartitionQuery: true }).toArray((err, results) => {
            if (err && err.code !== 409) {
                return e(err);
            }
            c(!results || results.length === 0 ? createDefaultConfig(quality) : results[0]);
        });
    }));
}
function createOrUpdate(commit, quality, platform, type, release, asset, isUpdate) {
    const client = new documentdb_1.DocumentClient(process.env['AZURE_DOCUMENTDB_ENDPOINT'], { masterKey: process.env['AZURE_DOCUMENTDB_MASTERKEY'] });
    const collection = 'dbs/builds/colls/' + quality;
    const updateQuery = {
        query: 'SELECT TOP 1 * FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: commit }]
    };
    let updateTries = 0;
    function update() {
        updateTries++;
        return new Promise((c, e) => {
            console.log(`Querying existing documents to update...`);
            client.queryDocuments(collection, updateQuery, { enableCrossPartitionQuery: true }).toArray((err, results) => {
                if (err) {
                    return e(err);
                }
                if (results.length !== 1) {
                    return e(new Error('No documents'));
                }
                const release = results[0];
                release.assets = [
                    ...release.assets.filter((a) => !(a.platform === platform && a.type === type)),
                    asset
                ];
                if (isUpdate) {
                    release.updates[platform] = type;
                }
                console.log(`Replacing existing document with updated version`);
                client.replaceDocument(release._self, release, err => {
                    if (err && err.code === 409 && updateTries < 5) {
                        return c(update());
                    }
                    if (err) {
                        return e(err);
                    }
                    console.log('Build successfully updated.');
                    c();
                });
            });
        });
    }
    return retry(() => new Promise((c, e) => {
        console.log(`Attempting to create document`);
        client.createDocument(collection, release, err => {
            if (err && err.code === 409) {
                return c(update());
            }
            if (err) {
                return e(err);
            }
            console.log('Build successfully published.');
            c();
        });
    }));
}
async function assertContainer(blobService, quality) {
    await new Promise((c, e) => blobService.createContainerIfNotExists(quality, { publicAccessLevel: 'blob' }, err => err ? e(err) : c()));
}
async function doesAssetExist(blobService, quality, blobName) {
    const existsResult = await new Promise((c, e) => blobService.doesBlobExist(quality, blobName, (err, r) => err ? e(err) : c(r)));
    return existsResult.exists;
}
async function uploadBlob(blobService, quality, blobName, file) {
    const blobOptions = {
        contentSettings: {
            contentType: mime.lookup(file),
            cacheControl: 'max-age=31536000, public'
        }
    };
    await new Promise((c, e) => blobService.createBlockBlobFromLocalFile(quality, blobName, file, blobOptions, err => err ? e(err) : c()));
}
async function publish(commit, quality, platform, type, name, version, _isUpdate, file, opts) {
    const isUpdate = _isUpdate === 'true';
    const queuedBy = process.env['BUILD_QUEUEDBY'];
    const sourceBranch = process.env['BUILD_SOURCEBRANCH'];
    console.log('Publishing...');
    console.log('Quality:', quality);
    console.log('Platform:', platform);
    console.log('Type:', type);
    console.log('Name:', name);
    console.log('Version:', version);
    console.log('Commit:', commit);
    console.log('Is Update:', isUpdate);
    console.log('File:', file);
    const stat = await new Promise((c, e) => fs.stat(file, (err, stat) => err ? e(err) : c(stat)));
    const size = stat.size;
    console.log('Size:', size);
    const stream = fs.createReadStream(file);
    const [sha1hash, sha256hash] = await Promise.all([hashStream('sha1', stream), hashStream('sha256', stream)]);
    console.log('SHA1:', sha1hash);
    console.log('SHA256:', sha256hash);
    const blobName = commit + '/' + name;
    const storageAccount = process.env['AZURE_STORAGE_ACCOUNT_2'];
    const blobService = azure.createBlobService(storageAccount, process.env['AZURE_STORAGE_ACCESS_KEY_2'])
        .withFilter(new azure.ExponentialRetryPolicyFilter(20));
    await assertContainer(blobService, quality);
    const blobExists = await doesAssetExist(blobService, quality, blobName);
    if (blobExists) {
        console.log(`Blob ${quality}, ${blobName} already exists, not publishing again.`);
        return;
    }
    console.log('Uploading blobs to Azure storage...');
    await uploadBlob(blobService, quality, blobName, file);
    console.log('Blobs successfully uploaded.');
    const config = await getConfig(quality);
    console.log('Quality config:', config);
    const asset = {
        platform: platform,
        type: type,
        url: `${process.env['AZURE_CDN_URL']}/${quality}/${blobName}`,
        hash: sha1hash,
        sha256hash,
        size
    };
    // Remove this if we ever need to rollback fast updates for windows
    if (/win32/.test(platform)) {
        asset.supportsFastUpdate = true;
    }
    console.log('Asset:', JSON.stringify(asset, null, '  '));
    // {{SQL CARBON EDIT}}
    // Insiders: nightly build from main
    const isReleased = (((quality === 'insider' && /^main$|^refs\/heads\/main$/.test(sourceBranch)) ||
        (quality === 'rc1' && /^release\/|^refs\/heads\/release\//.test(sourceBranch))) &&
        /Project Collection Service Accounts|Microsoft.VisualStudio.Services.TFS/.test(queuedBy));
    const release = {
        id: commit,
        timestamp: (new Date()).getTime(),
        version,
        isReleased: isReleased,
        sourceBranch,
        queuedBy,
        assets: [],
        updates: {}
    };
    if (!opts['upload-only']) {
        release.assets.push(asset);
        if (isUpdate) {
            release.updates[platform] = type;
        }
    }
    await createOrUpdate(commit, quality, platform, type, release, asset, isUpdate);
}
const RETRY_TIMES = 10;
async function retry(fn) {
    for (let run = 1; run <= RETRY_TIMES; run++) {
        try {
            return await fn();
        }
        catch (err) {
            if (!/ECONNRESET/.test(err.message)) {
                throw err;
            }
            console.log(`Caught error ${err} - ${run}/${RETRY_TIMES}`);
        }
    }
    throw new Error('Retried too many times');
}
function main() {
    const commit = process.env['BUILD_SOURCEVERSION'];
    if (!commit) {
        console.warn('Skipping publish due to missing BUILD_SOURCEVERSION');
        return;
    }
    const opts = minimist(process.argv.slice(2), {
        boolean: ['upload-only']
    });
    const [quality, platform, type, name, version, _isUpdate, file] = opts._;
    publish(commit, quality, platform, type, name, version, _isUpdate, file, opts).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
main();
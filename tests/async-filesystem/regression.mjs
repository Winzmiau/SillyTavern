import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, test } from 'node:test';
import { consumeJsonUpload, renameChatFile, withChatAccess } from '../../src/async-filesystem.js';

// Execute the actual endpoint bodies with only unrelated application dependencies
// stubbed. This avoids starting a server or accessing any user configuration/data.
const source = name => process.env.ST_ASYNC_BASELINE
    ? execFileSync('git', ['show', `1d8372abd3398be6ccde7f4fff41c126357ea8c4:src/endpoints/${name}.js`], { encoding: 'utf8' })
    : fs.readFileSync(new URL(`../../src/endpoints/${name}.js`, import.meta.url), 'utf8');
const chats = source('chats');
const characters = source('characters');
const quiet = { debug() {}, info() {}, error() {}, warn() {} };
const route = chats.slice(chats.indexOf("router.post('/rename'"), chats.indexOf("router.post('/delete'"));
const importer = characters.slice(characters.indexOf('async function importFromJson('), characters.indexOf('/**\n * Import a character from a PNG file.'));
const importRoute = characters.slice(characters.indexOf("router.post('/import'"), characters.indexOf("router.post('/duplicate'"));
let directory;
beforeEach(async () => { directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-async-')); });
afterEach(async () => { await fs.promises.rm(directory, { recursive: true, force: true }); });
const file = name => path.join(directory, name);
const write = (name, data = 'chat\n') => fs.promises.writeFile(file(name), data);
const exists = name => fs.existsSync(file(name));
function response() {
    return { code: 200, body: undefined, status(code) { this.code = code; return this; }, send(body) { this.body = body; return this; }, sendStatus(code) { this.code = code; return this; } };
}
function renameHandler(fn = renameChatFile) {
    let handler;
    vm.runInNewContext(route, {
        router: { post: (...args) => { handler = args.at(-1); } },
        validateAvatarUrlMiddleware() {}, path, fs, renameChatFile: fn, withChatAccess,
        sanitize: name => name.replace(/[/?<>\\:*|"\x00]/g, ''),
        isPathUnderParent: (parent, child) => child.startsWith(parent + path.sep), console: quiet,
    });
    return handler;
}
async function rename(source, destination, extra = {}, fn) {
    const res = response();
    await renameHandler(fn)({ body: { is_group: true, original_file: source, renamed_file: destination, ...extra }, user: { directories: { chats: directory, groupChats: directory } } }, res);
    return res;
}
function jsonHandler({ consume = consumeJsonUpload, persist = async () => true } = {}) {
    let handler;
    vm.runInNewContext(importer + importRoute, {
        router: { post: (...args) => { handler = args.at(-1); } },
        fs, path, console: quiet, consumeJsonUpload: consume, withChatAccess,
        getPreservedName: req => req.body.preserved_name,
        sanitize: name => name, humanizedDateTime: () => 'date',
        getPngName: name => name, convertToV2: data => data, readFromV2: data => data,
        importRisuSprites() {}, unsetPrivateFields() {}, invalidateThumbnail() {},
        DEFAULT_AVATAR_PATH: 'avatar.png', writeCharacterData: persist,
        importFromYaml() {}, importFromPng() {}, importFromCharX() {}, importFromByaf() {},
    });
    return handler;
}
async function importJson(name, options, body = {}) {
    const res = response();
    await jsonHandler(options)({ body: { file_type: 'json', ...body }, file: { destination: directory, filename: name }, user: { directories: { chats: directory } } }, res);
    return res;
}
const codeError = code => Object.assign(new Error(code), { code });

test('rename preserves bytes and response contract', async () => {
    const bytes = Buffer.from([0, 255, 13, 10, 1]); await write('a', bytes);
    const res = await rename('a', 'b.jsonl');
    assert.equal(res.code, 200); assert.equal(res.body.ok, true); assert.equal(res.body.sanitizedFileName, 'b');
    assert.equal(exists('a'), false); assert.deepEqual(await fs.promises.readFile(file('b.jsonl')), bytes);
});
test('missing source returns 400', async () => { assert.equal((await rename('a', 'b')).code, 400); assert.equal(exists('b'), false); });
test('occupied and identical destinations return 400 without changing contents', async () => {
    await write('a', 'source'); await write('b', 'target');
    assert.equal((await rename('a', 'b')).code, 400); assert.equal((await rename('a', 'a')).code, 400);
    assert.equal(await fs.promises.readFile(file('b'), 'utf8'), 'target'); assert.equal(exists('a'), true);
});
test('invalid body and escaping avatar path retain 400 security boundary', async () => {
    assert.equal((await rename('', 'b')).code, 400);
    assert.equal((await rename('a', 'b', { is_group: false, avatar_url: '../escape.png' })).code, 400);
});
test('concurrent requests with the same source have one winner', async () => {
    await write('a'); const results = await Promise.all([rename('a', 'b'), rename('a', 'c')]);
    assert.deepEqual(results.map(r => r.code).sort(), [200, 400]); assert.equal(Number(exists('b')) + Number(exists('c')), 1);
});
test('concurrent requests with the same destination never overwrite', async () => {
    await write('a', 'A'); await write('b', 'B');
    const results = await Promise.all([rename('a', 'c'), rename('b', 'c')]);
    assert.deepEqual(results.map(r => r.code).sort(), [200, 400]); assert.equal(Number(exists('a')) + Number(exists('b')), 1);
});
test('opposite path requests finish without deadlock', async () => {
    await write('a'); await Promise.all([rename('a', 'b'), rename('b', 'a')]);
    assert.equal(Number(exists('a')) + Number(exists('b')), 1);
});
test('destination created after validation is not overwritten', async t => {
    await write('a'); const copy = fs.promises.copyFile;
    t.mock.method(fs.promises, 'copyFile', async (source, destination, flags) => {
        await fs.promises.writeFile(destination, 'external'); return copy(source, destination, flags);
    });
    assert.equal((await rename('a', 'b')).code, 400); assert.equal(exists('a'), true);
    assert.equal(await fs.promises.readFile(file('b'), 'utf8'), 'external');
});
test('copy error returns 500, retains source and releases locks for retry', async t => {
    await write('a'); const mock = t.mock.method(fs.promises, 'copyFile', async () => { throw codeError('EIO'); });
    assert.equal((await rename('a', 'b')).code, 500); assert.equal(exists('a'), true); assert.equal(exists('b'), false);
    mock.mock.restore(); assert.equal((await rename('a', 'b')).code, 200);
});
test('source unlink failure retains both files and returns original 500 behavior', async t => {
    await write('a'); t.mock.method(fs.promises, 'unlink', async () => { throw codeError('EACCES'); });
    assert.equal((await rename('a', 'b')).code, 500); assert.equal(exists('a'), true); assert.equal(exists('b'), true);
});
for (const card of [{ name: 'v1' }, { spec: 'chara_card_v2', data: { name: 'v2' } }, { char_name: 'gradio' }]) {
    test(`JSON import success: ${card.name || card.data?.name || card.char_name}`, async () => {
        await write('upload', JSON.stringify(card)); let persisted;
        const res = await importJson('upload', { persist: async (...args) => { assert.equal(exists('upload'), false); persisted = JSON.parse(args[1]); return true; } });
        assert.equal(res.code, 200); assert.ok(res.body.file_name); assert.ok(persisted); assert.equal(exists('upload'), false);
    });
}
test('malformed JSON consumes upload before parsing and retains error response', async () => {
    await write('upload', '{'); const res = await importJson('upload'); assert.equal(res.code, 200); assert.equal(res.body.error, true); assert.equal(exists('upload'), false);
});
test('unrecognized JSON is consumed and returns 400', async () => {
    await write('upload', '{}'); assert.equal((await importJson('upload')).code, 400); assert.equal(exists('upload'), false);
});
test('missing upload retains import error response', async () => { const res = await importJson('missing'); assert.equal(res.code, 200); assert.equal(res.body.error, true); });
test('read failure retains upload and does not attempt deletion', async t => {
    await write('upload', '{}'); t.mock.method(fs.promises, 'readFile', async () => { throw codeError('EIO'); });
    const unlink = t.mock.method(fs.promises, 'unlink'); const res = await importJson('upload');
    assert.equal(res.body.error, true); assert.equal(exists('upload'), true); assert.equal(unlink.mock.callCount(), 0);
});
test('cleanup error prevents persistence, retains upload and releases lock', async t => {
    await write('upload', '{"name":"test"}'); let writes = 0;
    const mock = t.mock.method(fs.promises, 'unlink', async () => { throw codeError('EACCES'); });
    const res = await importJson('upload', { persist: async () => { writes++; return true; } });
    assert.equal(res.body.error, true); assert.equal(exists('upload'), true); assert.equal(writes, 0);
    mock.mock.restore(); assert.equal((await importJson('upload')).body.file_name, 'test');
});
for (const throws of [false, true]) {
    test(`persistence ${throws ? 'throws' : 'fails'} after upload consumption`, async () => {
        await write('upload', '{"name":"test"}');
        const res = await importJson('upload', { persist: async () => { if (throws) throw codeError('EIO'); return false; } });
        assert.equal(res.code, throws ? 200 : 400); if (throws) assert.equal(res.body.error, true); assert.equal(exists('upload'), false);
    });
}
test('concurrent imports of one upload persist exactly once', async () => {
    await write('upload', '{"name":"test"}'); let writes = 0;
    const options = { persist: async () => { writes++; return true; } };
    const results = await Promise.all([importJson('upload', options), importJson('upload', options)]);
    assert.equal(writes, 1); assert.equal(results.filter(r => r.body.file_name).length, 1);
});
test('independent uploads and preserved names retain success contract', async () => {
    await write('one', '{"name":"first"}'); await write('two', '{"name":"second"}');
    const results = await Promise.all([importJson('one', undefined, { preserved_name: 'existing' }), importJson('two')]);
    assert.deepEqual(results.map(r => r.body.file_name), ['existing', 'second']);
});
test('targeted paths never call synchronous filesystem methods', async t => {
    await write('a'); await write('upload', '{"name":"test"}');
    for (const method of ['existsSync', 'copyFileSync', 'unlinkSync', 'readFileSync']) t.mock.method(fs, method, () => { throw new Error(`blocking ${method}`); });
    assert.equal((await rename('a', 'b')).code, 200); assert.equal((await importJson('upload')).body.file_name, 'test');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import { renameChatFile, withChatAccess } from '../../src/async-filesystem.js';

const sourceText = fs.readFileSync(new URL('../../src/endpoints/chats.js', import.meta.url), 'utf8');
function handlers(directory) {
    const routes = {};
    const save = sourceText.slice(sourceText.indexOf("router.post('/save'"), sourceText.indexOf('/**\n * Gets the chat as an object.'));
    const rename = sourceText.slice(sourceText.indexOf("router.post('/rename'"), sourceText.indexOf("router.post('/delete'"));
    vm.runInNewContext(save + rename, {
        router: { post: (name, ...args) => { routes[name] = args.at(-1); } },
        withChatAccess, renameChatFile, fs, path, sanitize: name => name,
        validateAvatarUrlMiddleware() {}, isPathUnderParent: () => true,
        console: { debug() {}, info() {}, error() {} }, IntegrityMismatchError: class extends Error {},
        trySaveChat: async (data, file) => { fs.writeFileSync(file, data[0].mes); },
    });
    const request = body => ({ body, user: { profile: { handle: 'test' }, directories: { chats: directory, groupChats: directory } } });
    const response = () => ({ status() { return this; }, send(body) { this.body = body; return this; }, sendStatus(code) { this.code = code; return this; } });
    return { routes, request, response };
}

test('actual rename and save handlers preserve a save arriving inside the copy/delete window', async t => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-save-race-'));
    const source = path.join(directory, 'source.jsonl');
    const destination = path.join(directory, 'destination.jsonl');
    const { routes, request, response } = handlers(directory);
    let save;
    try {
        await fs.promises.mkdir(path.join(directory, 'card'));
        const characterSource = path.join(directory, 'card', 'source.jsonl');
        await fs.promises.writeFile(characterSource, 'original');
        const copy = fs.promises.copyFile;
        t.mock.method(fs.promises, 'copyFile', async (...args) => {
            await copy(...args);
            save = routes['/save'](request({ avatar_url: 'card.png', file_name: 'source', chat: [{ mes: 'concurrent-save' }] }), response());
            await tick();
            assert.equal(await fs.promises.readFile(characterSource, 'utf8'), 'original');
        });
        const res = response();
        await routes['/rename'](request({ avatar_url: 'card.png', original_file: 'source.jsonl', renamed_file: 'destination.jsonl' }), res);
        await save;
        assert.equal(res.body.ok, true);
        assert.equal(await fs.promises.readFile(characterSource, 'utf8'), 'concurrent-save');
        assert.equal(await fs.promises.readFile(path.join(directory, 'card', 'destination.jsonl'), 'utf8'), 'original');
        assert.equal(fs.existsSync(source), false); assert.equal(fs.existsSync(destination), false);
    } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
});

test('read/delete/directory lifecycle access cannot interleave with rename', async () => {
    const events = []; let releaseRename;
    const req = { user: { directories: { chats: '/test/coordination' } } };
    const rename = withChatAccess(async () => { events.push('rename-start'); await new Promise(resolve => { releaseRename = resolve; }); events.push('rename-end'); }, true);
    const run = rename(req, {}); await tick();
    const operations = ['read', 'delete', 'directory-delete'].map(name => withChatAccess(async () => { events.push(name); })(req, {}));
    await tick(); assert.deepEqual(events, ['rename-start']);
    releaseRename(); await Promise.all([run, ...operations]);
    assert.deepEqual(events.slice(0, 2), ['rename-start', 'rename-end']); assert.equal(events.length, 5);
});
test('ordinary operations retain concurrency and waiting rename is not starved', async () => {
    const req = { user: { directories: { chats: '/test/fairness' } } }; const events = []; let release;
    const first = withChatAccess(async () => { events.push('first'); await new Promise(resolve => { release = resolve; }); })(req, {});
    const second = withChatAccess(async () => { events.push('second'); })(req, {});
    await second; assert.deepEqual(events, ['first', 'second']);
    const rename = withChatAccess(async () => { events.push('rename'); }, true)(req, {});
    const later = withChatAccess(async () => { events.push('later'); })(req, {});
    await tick(); assert.equal(events.length, 2); release(); await Promise.all([first, rename, later]);
    assert.deepEqual(events, ['first', 'second', 'rename', 'later']);
});
test('different users are not serialized', async () => {
    let release; const firstReq = { user: { directories: { chats: '/test/user-one' } } };
    const first = withChatAccess(async () => { await new Promise(resolve => { release = resolve; }); }, true)(firstReq, {});
    await tick(); let ran = false;
    await withChatAccess(async () => { ran = true; })({ user: { directories: { chats: '/test/user-two' } } }, {});
    assert.equal(ran, true); release(); await first;
});
test('exception releases exclusive ownership and reaches Express error handling', async () => {
    const req = { user: { directories: { chats: '/test/error' } } }; const error = new Error('failure'); let received;
    await withChatAccess(async () => { throw error; }, true)(req, {}, err => { received = err; });
    assert.equal(received, error); let ran = false;
    await withChatAccess(async () => { ran = true; })(req, {}); assert.equal(ran, true);
});
test('disconnection does not release exclusive ownership before the async handler settles', async () => {
    const req = { user: { directories: { chats: '/test/disconnect' } } }; const res = new EventEmitter(); let release; let readerRan = false;
    const rename = withChatAccess(async () => { await new Promise(resolve => { release = resolve; }); }, true)(req, res);
    await tick(); res.emit('close');
    const read = withChatAccess(async () => { readerRan = true; })(req, {});
    await tick(); assert.equal(readerRan, false); release(); await Promise.all([rename, read]); assert.equal(readerRan, true);
});
test('callback-driven export retains ownership until response completion', async () => {
    const req = { user: { directories: { chats: '/test/export' } } }; const res = new EventEmitter(); let renameRan = false;
    const read = withChatAccess(() => {}, false, true)(req, res); await tick();
    const rename = withChatAccess(async () => { renameRan = true; }, true)(req, {});
    await tick(); assert.equal(renameRan, false); res.emit('finish'); await Promise.all([read, rename]); assert.equal(renameRan, true);
});
test('all cooperating endpoint registrations opt into access coordination', () => {
    for (const name of ['chats', 'characters', 'groups', 'data-maid', 'stats']) {
        const text = fs.readFileSync(new URL(`../../src/endpoints/${name}.js`, import.meta.url), 'utf8');
        const lines = text.split('\n').filter(line => line.startsWith('router.post('));
        assert.ok(lines.length > 0);
        for (const line of lines) assert.ok(line.includes('withChatAccess('), `${name}: ${line}`);
    }
});

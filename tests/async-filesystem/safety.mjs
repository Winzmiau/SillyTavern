import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { renameChatFile } from '../../src/async-filesystem.js';

// Release blocker: an existing synchronous save can run while async rename is
// between its copy and unlink. This test MUST pass before the draft is merged.
test('rename must not discard a concurrent chat save', async t => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-save-race-'));
    const source = path.join(directory, 'source.jsonl');
    const destination = path.join(directory, 'destination.jsonl');
    try {
        await fs.promises.writeFile(source, 'original');
        const copy = fs.promises.copyFile;
        t.mock.method(fs.promises, 'copyFile', async (...args) => {
            await copy(...args);
            // Same write mechanism used by existing chat save paths.
            fs.writeFileSync(source, 'concurrent-save');
        });
        await renameChatFile(source, destination);
        const contents = await Promise.all([source, destination].map(async file => {
            try { return await fs.promises.readFile(file, 'utf8'); }
            catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
        }));
        assert.ok(contents.includes('concurrent-save'), 'Concurrent saved content was discarded');
    } finally {
        await fs.promises.rm(directory, { recursive: true, force: true });
    }
});

import fs from 'node:fs';
import path from 'node:path';

/** @type {Map<string, Promise<void>>} */
const pending = new Map();

/** @type {Map<string, { readers: number, writer: boolean, queue: Array<{ exclusive: boolean, resolve: (release: () => void) => void }> }>} */
const chatAccess = new Map();

/**
 * Grant queued ordinary access together, but give renames exclusive access.
 * FIFO admission prevents sustained traffic from starving a waiting rename.
 * @param {string} key User chat directory
 * @param {boolean} exclusive Whether this is a rename
 * @returns {Promise<() => void>} Release callback
 */
function acquireChatAccess(key, exclusive) {
    let state = chatAccess.get(key);
    if (!state) {
        state = { readers: 0, writer: false, queue: [] };
        chatAccess.set(key, state);
    }
    return new Promise(resolve => {
        state.queue.push({ exclusive, resolve });
        pump();
    });

    function pump() {
        if (state.writer) return;
        while (state.queue.length) {
            const entry = state.queue[0];
            if (entry.exclusive && state.readers) return;
            state.queue.shift();
            if (entry.exclusive) state.writer = true;
            else state.readers++;
            entry.resolve(() => {
                if (entry.exclusive) state.writer = false;
                else state.readers--;
                pump();
                if (!state.writer && !state.readers && !state.queue.length) chatAccess.delete(key);
            });
            if (entry.exclusive) return;
        }
    }
}

/**
 * Keep rename's copy/delete window invisible to the existing endpoint operations.
 * Ordinary handlers retain their existing concurrency; only renames are exclusive.
 * Hold ownership until the handler settles, including after client disconnection.
 * @param {import('express').RequestHandler} handler Existing endpoint handler
 * @param {boolean} [exclusive=false] Exclusive rename access
 * @param {boolean} [waitForResponse=false] Callback-driven handler completion
 * @returns {import('express').RequestHandler} Coordinated handler
 */
export function withChatAccess(handler, exclusive = false, waitForResponse = false) {
    return async (request, response, next) => {
        const resolved = path.resolve(request.user.directories.chats);
        const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        const release = await acquireChatAccess(key, exclusive);
        // Some existing handlers start callback-driven reads and return before
        // sending their response (notably text chat export).
        const responseDone = waitForResponse && typeof response.once === 'function' && !response.writableEnded
            ? new Promise(resolve => {
                response.once('finish', resolve);
                response.once('close', resolve);
            })
            : Promise.resolve();
        try {
            const result = await handler(request, response, next);
            await responseDone;
            return result;
        } catch (error) {
            return next(error);
        } finally {
            release();
        }
    };
}

/**
 * Serialize operations sharing paths in this process. Sorted acquisition avoids deadlocks.
 * This does not lock other endpoint operations or other server processes.
 * @template T
 * @param {string[]} paths Paths owned by the operation
 * @param {() => Promise<T>} operation Operation to run
 * @returns {Promise<T>} Operation result
 */
async function withPaths(paths, operation) {
    const releases = [];
    try {
        for (const key of [...new Set(paths.map(p => path.resolve(p)))].sort()) {
            const previous = pending.get(key);
            let release;
            const current = new Promise(resolve => { release = resolve; });
            pending.set(key, current);
            releases.push(() => {
                if (pending.get(key) === current) pending.delete(key);
                release();
            });
            await previous;
        }
        return await operation();
    } finally {
        for (const release of releases.reverse()) release();
    }
}

/**
 * Match existsSync's unavailable-file handling without blocking the event loop.
 * @param {string} file File to check
 * @returns {Promise<boolean>} Whether the file is accessible
 */
async function exists(file) {
    try {
        await fs.promises.access(file);
        return true;
    } catch {
        return false;
    }
}

/**
 * Copy before deleting, retaining both files if source deletion fails, as before.
 * Exclusive creation also protects destinations created outside our local queue.
 * @param {string} source Original chat path
 * @param {string} destination New chat path
 * @returns {Promise<boolean>} False for unavailable source or occupied destination
 */
export async function renameChatFile(source, destination) {
    return withPaths([source, destination], async () => {
        if (!await exists(source) || await exists(destination)) return false;
        try {
            await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
        } catch (error) {
            if (error.code === 'EEXIST') return false;
            throw error;
        }
        await fs.promises.unlink(source);
        return true;
    });
}

/**
 * Consume a successful read before parsing. Failed reads retain the upload;
 * failed deletion propagates and prevents character persistence, as before.
 * @param {string} uploadPath Temporary upload path
 * @returns {Promise<string>} UTF-8 JSON contents
 */
export async function consumeJsonUpload(uploadPath) {
    return withPaths([uploadPath], async () => {
        const data = await fs.promises.readFile(uploadPath, 'utf8');
        await fs.promises.unlink(uploadPath);
        return data;
    });
}

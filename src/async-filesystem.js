import fs from 'node:fs';
import path from 'node:path';

/** @type {Map<string, Promise<void>>} */
const pending = new Map();

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

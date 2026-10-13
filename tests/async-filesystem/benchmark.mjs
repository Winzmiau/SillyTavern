import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { consumeJsonUpload, renameChatFile } from '../../src/async-filesystem.js';

// The probe runs in another process so the server's blocked event loop cannot
// delay issuing the ping itself. This measures isolated I/O, not full imports.
if (process.argv[2] === '--client') {
    const base = process.argv[3];
    const get = url => new Promise((resolve, reject) => {
        http.get(url, res => { res.resume(); res.on('end', resolve); }).on('error', reject);
    });
    const work = get(`${base}/work`);
    await new Promise(resolve => setTimeout(resolve, 2));
    const start = performance.now();
    await get(`${base}/ping`);
    const pingMs = performance.now() - start;
    await work;
    console.log(JSON.stringify({ pingMs }));
} else {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-io-bench-'));
    const source = path.join(dir, 'source');
    const destination = path.join(dir, 'destination');
    const bytes = Buffer.alloc(64 * 1024 * 1024, 97);
    let mode;
    let operation;
    let workMs;
    const server = http.createServer(async (req, res) => {
        if (req.url !== '/work') { res.end('pong'); return; }
        const start = performance.now();
        try {
            if (operation === 'rename') {
                if (mode === 'sync') { fs.copyFileSync(source, destination); fs.unlinkSync(source); }
                else await renameChatFile(source, destination);
            } else {
                if (mode === 'sync') { fs.readFileSync(source, 'utf8'); fs.unlinkSync(source); }
                else await consumeJsonUpload(source);
            }
            workMs = performance.now() - start;
            res.end('done');
        } catch (error) { res.statusCode = 500; res.end(String(error)); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const results = [];
    try {
        for (operation of ['rename', 'consume']) {
            for (mode of ['sync', 'async']) {
                const pings = []; const work = [];
                for (let i = 0; i < 7; i++) {
                    await fs.promises.writeFile(source, bytes);
                    await fs.promises.rm(destination, { force: true });
                    const output = await new Promise((resolve, reject) => {
                        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--client', url], { stdio: ['ignore', 'pipe', 'inherit'] });
                        let text = ''; child.stdout.on('data', chunk => { text += chunk; });
                        child.on('error', reject); child.on('exit', code => code === 0 ? resolve(text) : reject(new Error(`Client exit ${code}`)));
                    });
                    pings.push(JSON.parse(output).pingMs); work.push(workMs);
                }
                results.push({ operation, mode, pingMedianMs: median(pings), workMedianMs: median(work), pingSamplesMs: pings });
            }
        }
        console.log(JSON.stringify({ node: process.version, platform: process.platform, bytes: bytes.length, repetitions: 7, results }, null, 2));
    } finally {
        await new Promise(resolve => server.close(resolve));
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
}

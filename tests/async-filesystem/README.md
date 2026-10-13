# Async chat rename and JSON upload I/O

Base: `Winzmiau/SillyTavern` release commit
`1d8372abd3398be6ccde7f4fff41c126357ea8c4` (1.18.0).

The JSON importer now awaits UTF-8 read and deletion in that order before parsing.
Successful reads consume malformed/unsupported uploads; read failures retain them;
delete failures prevent persistence; existing response and persistence behavior is
unchanged. Other character import formats and downstream PNG writes are unchanged.

The chat rename implementation preserves validation, response bodies and copy-before-
delete ordering. It uses asynchronous access/copy/unlink, exclusive destination
creation, and sorted process-local path locks. Competing rename requests cannot
both consume a source or overwrite a shared destination. An unlink failure retains
both files and returns 500, as before. Destination creation during the operation
now returns 400 rather than overwriting the new file.

## Filesystem coordination

A rename-only lock was insufficient: a save between completed asynchronous copy
and source unlink could be discarded, and a reader could see a partial destination.
The final implementation grants chat rename exclusive access to a user's cooperating
endpoint handlers. Ordinary operations hold shared access and retain concurrency
with each other. FIFO admission prevents ordinary traffic from starving a rename.

Chat, character, group, Data Maid and statistics handlers opt into this coordination
because they read or mutate chat files, ownership or directory lifecycles. Their
existing validation middleware remains outside the coordinated handler. Only chat
rename is exclusive. Ordinary handler ownership lasts through handler settlement,
even on client disconnection; callback-driven text export additionally waits for
response completion. Coordination changes admission timing during rename, not
response status/body contracts or ordinary save/delete implementations.

`npm run test:async-filesystem:safety` now passes all eight tests, including the
actual rename/save endpoint bodies with a save deliberately queued inside the
copy/delete window. These supporting wrappers are necessary for this async change,
not unrelated endpoint refactoring.

Scope: one server process and the cooperating HTTP handlers. External processes,
plugins writing files directly, background maintenance outside those handlers,
filesystem aliases and administrative removal of an entire user data directory
are not covered by these locks. The original synchronous implementation also did
not provide cross-process transactions. Copy + unlink remains non-atomic under
crash or external mutation; exclusive copy protects destination creation by an
external writer but cannot supply a filesystem transaction. On unlink failure,
both files remain and the original error response is preserved.

## Executable checks and observed results

- `npm run test:async-filesystem`: 31 passing tests, actual endpoint bodies in a VM
  harness with unrelated application dependencies stubbed, and real temporary files.
  This is not a complete Express/Multer/image-persistence integration test.
- `npm run test:unit --prefix tests -- --runInBand`: 315 tests, 6 suites passing.
- `npm exec -- eslint src/async-filesystem.js src/endpoints/chats.js src/endpoints/characters.js src/endpoints/groups.js src/endpoints/data-maid.js src/endpoints/stats.js`:
  passing.
- `npm run test:async-filesystem:safety`: 8 passing concurrency/safety tests.
- Browser end-to-end tests were not run.
- 13 unchanged observable behavior cases also pass against the original source:

```sh
ST_ASYNC_BASELINE=1 node --test --test-name-pattern='rename preserves|missing source|occupied and identical|invalid body|JSON import success|malformed JSON|unrecognized JSON|missing upload|persistence.*after upload|independent uploads' tests/async-filesystem/regression.mjs
```

The baseline command requires the pinned base commit in the Git checkout. Fault
injection tests in the candidate suite exercise async APIs; they are not asserted
as equivalent fault-injection executions of the original synchronous code.

## Responsiveness experiment

`npm run benchmark:async-filesystem` starts a localhost HTTP server and an independent
client process, issuing a ping 2 ms after the I/O work request. Seven repetitions per
operation/mode, 64 MiB files, Linux/Node v24.19.0, local temporary storage:

| Isolated operation | Sync ping median | Async ping median | Sync work median | Async work median |
|---|---:|---:|---:|---:|
| Copy + unlink | 22.58 ms | 4.24 ms | 19.82 ms | 26.23 ms |
| UTF-8 read + unlink | 108.55 ms | 4.05 ms | 104.67 ms | 57.84 ms |

These are local synthetic I/O measurements, not a measured production regression
or end-to-end character-import speedup. Async copy was slower to finish in this
sample while allowing the ping to complete sooner. JSON parsing, image conversion,
other synchronous endpoints and PNG persistence can still block the event loop.

No deployment, merge or modification of user data was performed. No unrelated Jules
recommendation, Aletheia replay or graphics refactoring is included.

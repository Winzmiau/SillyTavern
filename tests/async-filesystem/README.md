# Async filesystem candidate — DRAFT, DO NOT MERGE

Base: `Winzmiau/SillyTavern` release commit
`1d8372abd3398be6ccde7f4fff41c126357ea8c4` (1.18.0).

The JSON importer now awaits UTF-8 read and deletion in that order before parsing.
Successful reads consume malformed/unsupported uploads; read failures retain them;
delete failures prevent persistence; existing response and persistence behavior is
unchanged. Other character import formats and downstream PNG writes are unchanged.

The chat rename candidate preserves validation, response bodies and copy-before-
delete ordering. It uses asynchronous access/copy/unlink, exclusive destination
creation, and sorted process-local path locks. Competing rename requests cannot
both consume a source or overwrite a shared destination. An unlink failure retains
both files and returns 500, as before. Destination creation during the operation
now returns 400 rather than overwriting the new file.

## Release blocker discovered during validation

**The candidate is NOT safe to merge.** Existing save/delete/import and character/
group lifecycle operations do not share the new locks. A synchronous chat save
between completed async copy and source unlink is discarded. The old synchronous
copy/unlink sequence does not yield to that same-process save. Partial destination
visibility to readers is also newly possible during the asynchronous copy.

`npm run test:async-filesystem:safety` deterministically reproduces the save race
and currently FAILS. Do not interpret the passing targeted tests as comprehensive
filesystem consistency validation. The next implementation must coordinate the
relevant writers, deletion/directory lifecycle and readers, or use a reviewed
publication protocol preserving the requested failure behavior. This extends the
necessary supporting changes beyond the two initial function bodies. Process-local
locks cannot guarantee cross-process/alias-path coordination; there is no claim of
crash atomicity or a filesystem transaction.

## Executable checks and observed results

- `npm run test:async-filesystem`: 23 passing tests, actual endpoint bodies in a VM
  harness with unrelated application dependencies stubbed, and real temporary files.
  This is not a complete Express/Multer/image-persistence integration test.
- `npm run test:unit --prefix tests -- --runInBand`: 315 tests, 6 suites passing.
- `npm exec -- eslint src/async-filesystem.js src/endpoints/chats.js src/endpoints/characters.js`:
  passing.
- `npm run test:async-filesystem:safety`: 1 failing release-blocking regression.
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

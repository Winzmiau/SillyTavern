<!-- INSTALL COPY of extensions/semantic-world-detach/README.md — keep in sync with the canonical tree (this copy previously drifted, silently dropping the Version Control section). -->

# Semantic World Engine - Detach Extension

Thin gateway extension for SillyTavern that detaches the **semantic backbone** (world state, characters, relations, farm, epistemic facts, schedules, OpenCyc microtheories) from the visualization / chat layer.

All authoritative state lives in the external Semantic World Kernel + middle layer (local MYCIN first).

## Files in this extension
- `index.js` — proposes intents via `/api/plugins/semantic-world/intent` (routes to middle layer)
- `manifest.json`
- `style.css` — placeholder

## Installation (on a SillyTavern instance)

1. Copy the `extensions/semantic-world-detach` folder into your ST `data/default-user/extensions/semantic-world-detach`
2. Copy `plugins/semantic-world` into your ST `plugins/semantic-world`
3. Restart ST
4. Enable the extension in the UI
5. Start the middle layer (`python local_ai_memory/scripts/semantic_middle_layer.py`)

## Usage
- Use the `/semantic <kind> <text>` slash command to send typed intents (MYCIN gated)
- The middle layer + kernel handle parsing, local rules, projections
- For walkable experience open `/cyberia.html` (or with `?engine=http://...` for remote kernel)
- Other extensions can call `window.proposeSemanticWorldAction(...)` or listen to `window.__semanticWorldProjections`

## Version Control

**All recoding and modifications to SillyTavern for this project are synced exclusively via the GitHub MCP connector** to `winzmiau/SillyTavern` on branch `feat/semantic-world-detach`.

This ensures proper version control of the thin gateway (ST extension + Node plugin) + exchangeable viz (Cyberia).

## Middle-layer contract (what a backend must implement)

The gateway (`plugins/semantic-world/index.mjs`) forwards to a middle layer
(default `http://127.0.0.1:8788`, override `SEMANTIC_WORLD_MIDDLE_URL`) with a
direct-kernel fallback (default `http://127.0.0.1:8787`, override
`SEMANTIC_WORLD_DIRECT_URL`):

- `POST /process_intent` — body as built by `index.js`:
  `{schema_version: 1, source, chat_id, message_id, world_id, branch_id,
  observer_actor_ids[], expected_event_seq, fork_policy:
  "auto_if_world_altering"|"always_experimental", intent_type, payload, raw_text}`
  → `200 {branch_id, new_revision, projections: {st, cyberia}}`;
  stale `expected_event_seq` should yield `409 {current_seq}`.
- `POST /assert_opencyc` — ontology assertion (`{child, parent}` or
  `{a, b, relation: "disjoint"}`).
- `GET /context` — bounded world context (query params passed through).

A reference implementation over an event-sourced MYCIN/OpenCyc world exists in
the EVE lab (`lab/cyberia/lab_semantic_middle_layer_v0.py`, 23 self-tests,
including verbatim goldens of the intent body this extension emits).

## Related
- Branch: feat/semantic-world-detach on winzmiau/SillyTavern
- See also: `plugins/semantic-world/index.mjs` (gateway) and
  `plugins/semantic-world/index.test.mjs` (tests). The kernel sources
  (`semantic_world_engine/`, `DETACHMENT_ARCHITECTURE.md`) live in the external
  semantic-world-engine project, not in this repository.

This is part of forging a version-controlled SillyTavern with detached semantic core (winzmiau/SillyTavern).
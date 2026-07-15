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

## Related
- Branch: feat/semantic-world-detach on winzmiau/SillyTavern
- See also: plugins/semantic-world/index.mjs and the semantic_world_engine/ sources + DETACHMENT_ARCHITECTURE.md

This is part of forging a version-controlled SillyTavern with detached semantic core (winzmiau/SillyTavern).
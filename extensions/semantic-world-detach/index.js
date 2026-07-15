// SillyTavern extension for Semantic World Engine (thin client - detached semantic backbone)
// Stores ONLY bindings + UI state. All world truth lives in external kernel.
// Middle layer (semantic_middle_layer.py) does parsing + local MYCIN + projection to exchangeable viz (Cyberia walkable 3D etc.)

const MIDDLE_LAYER_URL = "http://127.0.0.1:8788/process_intent"; // Points to our Python middle layer (local MYCIN first)

async function proposeIntent(kind, payload) {
  const ctx = SillyTavern.getContext();
  const meta = ctx.chatMetadata.semantic_world_engine ?? {};

  const body = {
    schema_version: 1,
    source: "sillytavern",
    chat_id: ctx.chatId ?? ctx.groupId ?? "unknown",
    message_id: payload.message_id ?? null,
    world_id: meta.world_id,
    branch_id: meta.branch_id,
    observer_actor_ids: meta.observer_actor_ids ?? [],
    expected_event_seq: meta.last_event_seq ?? 0,
    fork_policy: payload.experimental ? "always_experimental" : "auto_if_world_altering",
    intent_type: kind,
    payload,
    raw_text: payload.raw_text || ctx.lastMessage?.mes || ""
  };

  // Send to middle layer (which runs local MYCIN before touching kernel)
  const res = await fetch("/api/plugins/semantic-world/intent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const result = await res.json();

  if (result.branch_id && result.branch_id !== meta.branch_id) {
    ctx.chatMetadata.semantic_world_engine = {
      ...meta,
      branch_id: result.branch_id,
      last_event_seq: result.new_revision || meta.last_event_seq
    };
    await ctx.saveMetadata();
  }

  // If middle layer returned viz projections (e.g. Cyberia walkable data), expose for other extensions / Cyberia seam
  if (result.projections) {
    window.__semanticWorldProjections = result.projections;
    // Example: forward Cyberia frame to seam if available
    if (result.projections.cyberia && window.postCyberiaFrame) {
      window.postCyberiaFrame(result.projections.cyberia);
    }
  }

  return result;
}

// Enhanced for walkable viz: support map clicks / coordinate actions as semantic intents
async function proposeWorldAction(actionType, coordsOrData) {
  return proposeIntent(actionType, {
    ...coordsOrData,
    raw_text: `Player performed ${actionType}`,
    experimental: false
  });
}

// Register hooks for detachment + walkable experience
export async function onEnable() {
  console.log("Semantic World Engine (detached) extension enabled. Semantic backbone is external.");

  const ctx = SillyTavern.getContext();

  // Slash command for manual intents (useful for testing middle layer + MYCIN)
  ctx.registerSlashCommand?.("semantic", async (args) => {
    const [kind, ...rest] = args.split(" ");
    const payload = { raw_text: rest.join(" ") };
    const res = await proposeIntent(kind || "narrative_action", payload);
    ctx.addOneMessage?.({ mes: `[Semantic] ${JSON.stringify(res).slice(0, 200)}`, is_system: true });
  }, "Send typed intent to middle layer (local MYCIN gate first)");

  // Listen for chat changes to keep bindings fresh (detachment point)
  ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
    // Re-read bindings on chat switch - kernel is source of truth
    console.log("Semantic bindings refreshed for new chat context");
  });

  // Optional: hook into message rendering to parse tags like <WorldState> or <FugueState> (TheWorld/Fugue inspired)
  // Real production would use a more robust tag parser in middle layer.
}

// Support for exchangeable visualization (Cyberia walkable, etc.)
// Other viz layers can listen to window.__semanticWorldProjections or call proposeWorldAction
window.proposeSemanticWorldAction = proposeWorldAction;

export async function onDisable() {
  console.log("Semantic World Engine extension disabled. Bindings remain in chatMetadata.");
}
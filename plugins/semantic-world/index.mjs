// SillyTavern server plugin gateway for semantic-world-engine (detached backbone)
// Routes through the Python middle layer (semantic_middle_layer.py) which does:
// - Parsing of ST semantic info
// - Local MYCIN workflows first (machine-local, explainable)
// - Escalation to LLM only on low CF / error for new rule creation
// - Projection to exchangeable visualization (Cyberia walkable 3D etc.)

// Middle layer (preferred) runs local MYCIN before kernel.
// Both backends are overridable via environment so deployments (and tests) can
// point the gateway anywhere without editing source:
//   SEMANTIC_WORLD_MIDDLE_URL  (default http://127.0.0.1:8788)
//   SEMANTIC_WORLD_DIRECT_URL  (default http://127.0.0.1:8787)
const MIDDLE = process.env.SEMANTIC_WORLD_MIDDLE_URL || "http://127.0.0.1:8788";
// Fallback to direct swe if middle not running (v0.4 reference)
const DIRECT_SWE = process.env.SEMANTIC_WORLD_DIRECT_URL || "http://127.0.0.1:8787";

export const info = {
  id: "semantic-world",
  name: "Semantic World Engine Gateway (with local MYCIN middle layer)",
  description: "Detaches semantic backbone (world/characters/rules) from ST viz. Middle layer parses + runs local MYCIN. OpenCyc microtheories supported via kernel."
};

export async function init(router) {
  router.post("/intent", async (req, res) => {
    const proposal = req.body;

    // Prefer middle layer (does the parsing + local MYCIN gate as requested)
    let target = `${MIDDLE}/process_intent`;
    let useMiddle = true;

    try {
      const response = await fetch(target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ST-Gateway": "semantic-world-middle"
        },
        body: JSON.stringify(proposal)
      });

      if (response.ok) {
        const data = await response.json();
        // Also forward useful projections back to ST context if present
        if (data.projections?.st) {
          // The extension will pick this up
        }
        return res.status(response.status).json(data);
      }
    } catch (e) {
      console.log("[semantic-world-plugin] Middle layer not available, falling back to direct SWE");
      useMiddle = false;
    }

    // Fallback to direct v0.4 swe
    const response = await fetch(`${DIRECT_SWE}/v1/intent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ST-Gateway": "semantic-world-direct"
      },
      body: JSON.stringify(proposal)
    });

    res.status(response.status).json(await response.json());
  });

  // Additional endpoints for OpenCyc-style assertions and viz
  router.post("/assert_opencyc", async (req, res) => {
    try {
      const r = await fetch(`${MIDDLE}/assert_opencyc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body)
      });
      res.json(await r.json());
    } catch {
      res.status(503).json({ error: "Middle layer unavailable for OpenCyc assertion" });
    }
  });

  router.get("/context", async (req, res) => {
    // Prefer middle or direct projection
    try {
      const r = await fetch(`${MIDDLE}/context?${new URLSearchParams(req.query)}`);
      if (r.ok) return res.json(await r.json());
    } catch {}
    const url = new URL(`${DIRECT_SWE}/v1/context`);
    for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, String(v));
    const response = await fetch(url);
    res.status(response.status).json(await response.json());
  });
}

export async function exit() {
  console.log("Semantic World gateway exiting (middle layer + kernel remain authoritative)");
}
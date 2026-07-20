// Tests for the semantic-world gateway plugin (node:test, zero dependencies).
// Run:  node --test plugins/semantic-world/
// Uses SEMANTIC_WORLD_MIDDLE_URL / SEMANTIC_WORLD_DIRECT_URL to point the gateway
// at in-process mock backends on ephemeral ports.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// -- mock backends -------------------------------------------------------------------------
function mockServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

const seen = { middle: [], direct: [] };

const middle = await mockServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.middle.push({ path: req.url, gateway: req.headers["x-st-gateway"], body });
    if (req.url.startsWith("/context")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ from: "middle-context", query: req.url }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ from: "middle", branch_id: "main", new_revision: 1,
                             projections: { st: {}, cyberia: {} } }));
  });
});

const direct = await mockServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.direct.push({ path: req.url, gateway: req.headers["x-st-gateway"], body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ from: "direct" }));
  });
});

const deadPort = await (async () => {
  const s = await mockServer(() => {});
  const p = s.address().port;
  await new Promise((r) => s.close(r));            // freed port = connection refused
  return p;
})();

process.env.SEMANTIC_WORLD_MIDDLE_URL = `http://127.0.0.1:${middle.address().port}`;
process.env.SEMANTIC_WORLD_DIRECT_URL = `http://127.0.0.1:${direct.address().port}`;

const { init, info } = await import("./index.mjs");

// -- a minimal Express-compatible router + req/res stubs -----------------------------------
function makeRouter() {
  const routes = { post: {}, get: {} };
  return {
    routes,
    post: (p, h) => (routes.post[p] = h),
    get: (p, h) => (routes.get[p] = h),
  };
}

function makeRes() {
  const out = { statusCode: 200, body: null };
  const res = {
    status(c) { out.statusCode = c; return res; },
    json(o) { out.body = o; return res; },
  };
  return { res, out };
}

const router = makeRouter();
await init(router);

after(async () => {
  await new Promise((r) => middle.close(r));
  await new Promise((r) => direct.close(r));
});

// -- the tests ------------------------------------------------------------------------------
test("plugin exposes id/name metadata", () => {
  assert.equal(info.id, "semantic-world");
  assert.ok(info.name.length > 0);
});

test("init registers /intent, /assert_opencyc, /context", () => {
  assert.ok(router.routes.post["/intent"]);
  assert.ok(router.routes.post["/assert_opencyc"]);
  assert.ok(router.routes.get["/context"]);
});

test("/intent prefers the middle layer and forwards the X-ST-Gateway header", async () => {
  seen.middle.length = 0;
  const { res, out } = makeRes();
  await router.routes.post["/intent"]({ body: { schema_version: 1, intent_type: "t" } }, res);
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.from, "middle");
  assert.equal(seen.middle.at(-1).path, "/process_intent");
  assert.equal(seen.middle.at(-1).gateway, "semantic-world-middle");
  const forwarded = JSON.parse(seen.middle.at(-1).body);
  assert.equal(forwarded.schema_version, 1);       // proposal forwarded intact
});

test("/intent falls back to the direct kernel when the middle layer is down", async () => {
  const saved = process.env.SEMANTIC_WORLD_MIDDLE_URL;
  process.env.SEMANTIC_WORLD_MIDDLE_URL = `http://127.0.0.1:${deadPort}`;
  // re-import with a cache-busting query so the module re-reads env
  const fresh = await import(`./index.mjs?fallback=${Date.now()}`);
  const r2 = makeRouter();
  await fresh.init(r2);
  seen.direct.length = 0;
  const { res, out } = makeRes();
  await r2.routes.post["/intent"]({ body: { intent_type: "t" } }, res);
  assert.equal(out.body.from, "direct");
  assert.equal(seen.direct.at(-1).path, "/v1/intent");
  assert.equal(seen.direct.at(-1).gateway, "semantic-world-direct");
  process.env.SEMANTIC_WORLD_MIDDLE_URL = saved;
});

test("/assert_opencyc proxies to the middle layer", async () => {
  seen.middle.length = 0;
  const { res, out } = makeRes();
  await router.routes.post["/assert_opencyc"](
    { body: { child: "Shadowfang", parent: "Monster" } }, res);
  assert.equal(seen.middle.at(-1).path, "/assert_opencyc");
  assert.equal(out.body.from, "middle");
});

test("/assert_opencyc returns 503 when the middle layer is unreachable", async () => {
  const saved = process.env.SEMANTIC_WORLD_MIDDLE_URL;
  process.env.SEMANTIC_WORLD_MIDDLE_URL = `http://127.0.0.1:${deadPort}`;
  const fresh = await import(`./index.mjs?a503=${Date.now()}`);
  const r2 = makeRouter();
  await fresh.init(r2);
  const { res, out } = makeRes();
  await r2.routes.post["/assert_opencyc"]({ body: {} }, res);
  assert.equal(out.statusCode, 503);
  assert.match(out.body.error, /unavailable/i);
  process.env.SEMANTIC_WORLD_MIDDLE_URL = saved;
});

test("/context forwards query parameters to the middle layer", async () => {
  seen.middle.length = 0;
  const { res, out } = makeRes();
  await router.routes.get["/context"]({ query: { branch_id: "main", depth: "2" } }, res);
  assert.equal(out.body.from, "middle-context");
  assert.match(seen.middle.at(-1).path, /branch_id=main/);
  assert.match(seen.middle.at(-1).path, /depth=2/);
});

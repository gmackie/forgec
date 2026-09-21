import assert from "node:assert/strict";
const base = process.env.CONSOLE_TEST_URL || "http://127.0.0.1:8787";
const auth = { authorization: "Bearer local-console-test-token-1234567890" };
assert.equal((await fetch(base + "/")).status, 200);
assert.equal((await fetch(base + "/api/state")).status, 401);
const response = await fetch(base + "/api/state", { headers: auth });
assert.equal(response.status, 200);
const state = await response.json();
const name = process.env.SMOKE_APP || `Restart smoke ${Date.now()}`;
if (!state.apps.some((app) => app.name === name)) {
  const created = await fetch(base + "/api/apps", {
    method: "POST",
    headers: {
      ...auth,
      "content-type": "application/json",
      "if-match": String(state.revision),
    },
    body: JSON.stringify({ name, description: "Persistence verification" }),
  });
  assert.equal(created.status, 201);
} else console.log("Persisted app survived restart");
const root = await fetch(base + "/");
assert.match(root.headers.get("content-security-policy"), /connect-src 'self'/);
console.log("HTTP_SMOKE_OK", base, name);

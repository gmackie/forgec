// Runtime compatibility probe only: no live vendor traffic, no credentials.
import { CloudflareApiClient as GitHub } from "./.cache/github-sdk/sdk/Client.ts";
import { CloudflareApiClient as Cloudflare } from "./.cache/cloudflare-sdk/sdk/Client.ts";
export default {
  async fetch() {
    const calls = [];
    const github = new GitHub({
      baseUrl: "https://fixture.example",
      maxRetries: 0,
      fetch: async (url, init) => {
        calls.push({ vendor: "github", url: String(url), method: init.method });
        return Response.json({ id: 17 });
      },
    });
    const cloudflare = new Cloudflare({
      baseUrl: "https://fixture.example",
      auth: false,
      maxRetries: 0,
      fetch: async (url, init) => {
        calls.push({ vendor: "cloudflare", url: String(url), method: init.method });
        return Response.json({ success: true, result: { id: "dns-1" }, errors: [], messages: [] });
      },
    });
    const issue = await github.issues.create({ owner: "team", repo: "repo", title: "fixture" });
    const record = await cloudflare.dns.records.create({
      zone_id: "zone",
      body: { type: "A", name: "example.test", content: "192.0.2.1" },
    });
    return Response.json({ issue, record, calls });
  },
};

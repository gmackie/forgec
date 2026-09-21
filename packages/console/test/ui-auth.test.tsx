// @vitest-environment jsdom
/**
 * How the console behaves when the server does not answer with the JSON it hoped for.
 *
 * The previous request helper parsed the body before checking the status, so any non-JSON
 * response — a login page, a proxy error, an empty body — surfaced as an unreadable
 * `SyntaxError` instead of the status that explained it. That was already wrong with a shared
 * token; under Cloudflare Access, where an expired session is answered with an HTML login page,
 * it would have been the normal failure.
 */
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { Console } from "../web/console.js";

const emptyState = {
  revision: 0,
  apps: [],
  audit: [],
  instance: {
    name: "Forge",
    authority: "forge.example",
    runtime: "Cloudflare Workers",
    registry: null,
    authMode: "cloudflare-access",
    identityAuthority: "team.cloudflareaccess.com",
  },
};

describe("console authentication behaviour", () => {
  // Without this the previous case's DOM persists and every query sees stale nodes.
  afterEach(cleanup);
  it("signs in with no token when the edge already authenticated the request", async () => {
    const seen: RequestInit[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return Response.json(emptyState);
    }) as unknown as typeof fetch;

    render(<Console fetcher={fetcher} />);
    // No token form: the operator is already signed in via Access.
    await waitFor(() => expect(screen.queryByLabelText("Administrator token")).toBeNull());
    await screen.findByText("Apps");
    // The browser must not invent an Authorization header it does not have.
    expect(seen[0]?.headers).not.toHaveProperty("authorization");
    expect(seen[0]?.credentials).toBe("same-origin");
  });

  it("reports an HTML response by its status instead of a SyntaxError", async () => {
    const fetcher = (async () =>
      new Response("<!doctype html><title>Sign in</title>", {
        status: 502,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch;

    render(<Console fetcher={fetcher} autoAuth={false} />);
    const form = await screen.findByLabelText("Administrator token");
    expect(form).toBeTruthy();
    // Signing in surfaces the status, not a parser error about unexpected "<".
    (form as HTMLInputElement).value = "x".repeat(40);
    screen.getByRole("button", { name: "Connect to instance" }).click();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/502/));
    expect(screen.getByRole("alert").textContent).not.toMatch(/JSON|SyntaxError|token '<'/i);
  });

  it("stays on the sign-in card when the probe finds no session", async () => {
    const fetcher = (async () =>
      Response.json({ error: "Unauthorized" }, { status: 401 })) as unknown as typeof fetch;
    render(<Console fetcher={fetcher} />);
    // A failed probe is the ordinary unauthenticated case and must not be shouted about.
    await screen.findByLabelText("Administrator token");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reloads rather than following a cross-origin re-authentication redirect by fetch", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload, href: "https://forge.example/" });
    // What a browser hands back for an opaque cross-origin redirect under redirect: "manual".
    const opaque = {
      type: "opaqueredirect",
      status: 0,
      ok: false,
      text: async () => "",
    };
    const fetcher = (async () => opaque) as unknown as typeof fetch;
    render(<Console fetcher={fetcher} />);
    await waitFor(() => expect(reload).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });
});

import { Context, Effect } from "effect";
import { z } from "zod";
import type { AppBundle } from "@forgegraph/runtime";
import {
  Problem,
  type State,
  type StateStore,
  type ViewState,
} from "./model.js";
import type { OciRegistry } from "./oci.js";
import { tokenAuth, type AuthAdapter } from "./auth.js";
const name = z.string().trim().min(1).max(120);
const appInput = z
  .object({ name, description: z.string().max(2000).default("") })
  .strict();
const record = z
  .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4000))
  .refine((v) => Object.keys(v).length <= 100, "At most 100 entries");
const environmentInput = z
  .object({
    name,
    target: z.enum(["cloudflare", "docker", "aws", "other"]),
    endpoint: z
      .string()
      .max(2048)
      .refine((s) => {
        try {
          const u = new URL(s);
          return (
            ["https:", "http:"].includes(u.protocol) &&
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash
          );
        } catch {
          return false;
        }
      }, "Enter an HTTP(S) endpoint without credentials, query or fragment"),
    packageDigest: z.string().regex(/^$|^sha256:[a-f0-9]{64}$/),
    config: record,
    secretRefs: record,
  })
  .strict();
const publishInput = z
  .object({
    name: z
      .string()
      .regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/)
      .max(200),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
      .max(100),
    owner: z.string().max(120),
    commit: z.string().max(200),
    bundle: z.record(z.string(), z.unknown()),
  })
  .strict();
export interface ApiOptions {
  store: StateStore;
  /** Supply an adapter, or `token` below to use the shared-administrator scheme. */
  auth?: AuthAdapter;
  token?: string;
  authMode?: "token" | "cloudflare-access";
  identityAuthority?: string | null;
  authority: string;
  name: string;
  runtime: string;
  registry: OciRegistry | null;
}
class Management extends Context.Service<Management, ApiOptions>()(
  "forge-console/Management",
) {}
const attempt = <A>(fn: () => Promise<A>) =>
  Effect.tryPromise({
    try: fn,
    catch: (error) => {
      if (!(error instanceof Problem))
        console.error(
          "Console operation failed",
          error instanceof Error
            ? { name: error.name, frames: error.stack?.split("\n").slice(1, 4) }
            : "UnknownError",
        );
      return error instanceof Problem
        ? error
        : new Problem(
            500,
            "The operation failed. Check instance storage, registry integrity and configuration.",
          );
    },
  });
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new Problem(415, "Send application/json.");
  const reader = request.body?.getReader();
  if (!reader) throw new Problem(400, "Request body required.");
  const chunks: Uint8Array[] = [];
  let count = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    count += part.value.length;
    if (count > 4_000_000) {
      await reader.cancel();
      throw new Problem(413, "Request exceeds 4 MB.");
    }
    chunks.push(part.value);
  }
  const joined = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(joined));
  } catch {
    throw new Problem(400, "Invalid JSON.");
  }
}
function decode<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new Problem(
      400,
      parsed.error.issues
        .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
        .join("; "),
    );
  return parsed.data;
}
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
function view(state: State, o: ApiOptions): ViewState {
  return {
    ...state,
    instance: {
      name: o.name,
      authority: o.authority,
      runtime: o.runtime,
      registry: o.registry
        ? { url: o.registry.url, repository: o.registry.repository }
        : null,
      authMode: o.authMode ?? "token",
      identityAuthority: o.identityAuthority ?? null,
    },
  };
}
function route(request: Request) {
  return Effect.gen(function* () {
    const o = yield* Management;
    // Before routing, so an unauthenticated caller cannot learn which paths exist.
    const auth = o.auth ?? tokenAuth(o.token ?? "");
    const identity = yield* attempt(() => auth.authenticate(request));
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.slice(4);
    if (method !== "GET") {
      const origin = request.headers.get("origin");
      // A header-borne token is only ever sent deliberately, so a missing Origin is tolerated
      // for CLI callers. A cookie rides along on cross-site requests, so there it is required.
      if (origin ? origin !== url.origin : auth.cookieBorne)
        return yield* Effect.fail(
          new Problem(403, "Cross-origin writes are not allowed."),
        );
    }
    if (path === "/state" && method === "GET")
      return json(view(yield* attempt(() => o.store.read()), o));
    if (path === "/packages" && method === "GET") {
      if (!o.registry) return json({ packages: [], configured: false });
      return json({
        packages: yield* attempt(() => o.registry!.list()),
        configured: true,
      });
    }
    if (path.startsWith("/packages/") && method === "GET") {
      if (!o.registry)
        return yield* Effect.fail(
          new Problem(503, "Configure an OCI registry first."),
        );
      return json(
        yield* attempt(() => o.registry!.pull(path.slice("/packages/".length))),
      );
    }
    if (path === "/packages" && method === "POST") {
      if (!o.registry)
        return yield* Effect.fail(
          new Problem(503, "Configure an OCI registry first."),
        );
      const input = yield* attempt(async () =>
        decode(publishInput, await body(request)),
      );
      const result = yield* attempt(() =>
        o.registry!.publish(
          { ...input, bundle: input.bundle as unknown as AppBundle },
          (key) => o.store.reservePublication(key),
        ),
      );
      return json(result, 201);
    }
    const segments = path.split("/").filter(Boolean);
    const appRoute =
      segments[0] === "apps" &&
      ((segments.length === 1 && method === "POST") ||
        (segments.length === 2 && method === "PATCH") ||
        (segments[2] === "environments" &&
          ((segments.length === 3 && method === "POST") ||
            (segments.length === 4 &&
              (method === "PUT" || method === "DELETE")))));
    if (!appRoute)
      return yield* Effect.fail(new Problem(404, "API route not found."));
    const header = request.headers.get("if-match");
    if (header === null)
      return yield* Effect.fail(
        new Problem(428, "Refresh and retry with the current revision."),
      );
    if (!/^\d+$/.test(header) || !Number.isSafeInteger(Number(header)))
      return yield* Effect.fail(new Problem(400, "Invalid revision."));
    const expected = Number(header);
    const state = yield* attempt(() => o.store.read());
    if (state.revision !== expected)
      return yield* Effect.fail(
        new Problem(
          409,
          "Configuration changed in another session. Refresh before saving again.",
        ),
      );
    const data =
      method === "DELETE" ? null : yield* attempt(() => body(request));
    const now = new Date().toISOString();
    let action = "";
    let subject = "";
    let status = 200;
    yield* attempt(async () => {
      if (segments.length === 1) {
        const input = decode(appInput, data);
        if (
          state.apps.some(
            (a) => a.name.toLowerCase() === input.name.toLowerCase(),
          )
        )
          throw new Problem(409, "An app with this name already exists.");
        if (state.apps.length >= 200)
          throw new Problem(
            400,
            "This instance supports at most 200 app registrations.",
          );
        state.apps.push({
          ...input,
          id: crypto.randomUUID(),
          archived: false,
          environments: [],
          updatedAt: now,
        });
        action = "App registered";
        subject = input.name;
        status = 201;
        return;
      }
      const app = state.apps.find((a) => a.id === segments[1]);
      if (!app) throw new Problem(404, "App not found.");
      subject = app.name;
      if (segments.length === 2) {
        const input = decode(appInput.extend({ archived: z.boolean() }), data);
        if (
          state.apps.some(
            (a) =>
              a.id !== app.id &&
              a.name.toLowerCase() === input.name.toLowerCase(),
          )
        )
          throw new Problem(409, "An app with this name already exists.");
        Object.assign(app, input);
        action = input.archived ? "App archived" : "App updated";
      } else {
        if (app.archived)
          throw new Problem(
            409,
            "Restore this app before editing environments.",
          );
        const index = app.environments.findIndex((e) => e.id === segments[3]);
        if (segments.length === 4 && index < 0)
          throw new Problem(404, "Environment not found.");
        if (method === "DELETE") {
          const removed = app.environments.splice(index, 1)[0]!;
          action = "Environment removed";
          subject += ` / ${removed.name}`;
        } else {
          const input = decode(environmentInput, data);
          if (
            app.environments.some(
              (e) =>
                e.id !== segments[3] &&
                e.name.toLowerCase() === input.name.toLowerCase(),
            )
          )
            throw new Problem(
              409,
              "An environment with this name already exists.",
            );
          if (Object.keys(input.secretRefs).some((k) => k in input.config))
            throw new Problem(
              400,
              "A key cannot be both configuration and a secret reference.",
            );
          if (input.packageDigest) {
            if (!o.registry)
              throw new Problem(
                400,
                "Configure an OCI registry before pinning a package.",
              );
            await o.registry.pull(input.packageDigest);
          }
          if (method === "POST") {
            if (app.environments.length >= 30)
              throw new Problem(400, "At most 30 environments per app.");
            app.environments.push({ ...input, id: crypto.randomUUID() });
            status = 201;
          } else app.environments[index] = { ...input, id: segments[3]! };
          action =
            method === "POST" ? "Environment added" : "Environment configured";
          subject += ` / ${input.name}`;
        }
      }
      app.updatedAt = now;
    });
    state.revision++;
    state.audit.unshift({
      id: crypto.randomUUID(),
      at: now,
      action,
      subject,
      actor: identity.actor,
    });
    state.audit = state.audit.slice(0, 200);
    if (!(yield* attempt(() => o.store.save(expected, state))))
      return yield* Effect.fail(
        new Problem(
          409,
          "Configuration changed in another session. Refresh before saving again.",
        ),
      );
    return json(view(state, o), status);
  });
}
export function createApi(
  options: ApiOptions,
): (request: Request) => Promise<Response> {
  return (request) =>
    Effect.runPromise(
      route(request).pipe(
        Effect.provideService(Management, options),
        Effect.catch((error: Problem) =>
          Effect.succeed(json({ error: error.message }, error.status)),
        ),
      ),
    );
}

import { Context, Effect } from "effect";
import { z } from "zod";
import type { AppBundle } from "@forgegraph/runtime";
import {
  Problem,
  type State,
  type StateStore,
  type ViewState,
} from "./model.js";
import { deploymentAction, type DeploymentConnection } from "./deployment-control.js";
import type { RuntimeConnection } from "./runtime-control.js";
import { gitCommitSchema, type GitRepository } from "./git.js";
import type { Studio } from "./studio.js";
import type { OciRegistry } from "./oci.js";
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
  studio?: Studio;
  store: StateStore;
  token: string;
  authority: string;
  name: string;
  runtime: string;
  registry: OciRegistry | null;
  git?: GitRepository[];
  runtimes?: RuntimeConnection[];
  deployments?: DeploymentConnection[];
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
async function equalToken(actual: string, expected: string): Promise<boolean> {
  const hash = async (s: string) =>
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    );
  const [a, b] = await Promise.all([hash(actual), hash(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
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
    },
  };
}
function route(request: Request) {
  return Effect.gen(function* () {
    const o = yield* Management;
    if (o.token.length < 32)
      return yield* Effect.fail(
        new Problem(
          503,
          "Configure an administrator token of at least 32 characters.",
        ),
      );
    if (
      !(yield* attempt(() =>
        equalToken(
          request.headers.get("authorization") ?? "",
          `Bearer ${o.token}`,
        ),
      ))
    )
      return yield* Effect.fail(
        new Problem(401, "Enter this instance’s administrator token."),
      );
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname.slice(4);
    if (method !== "GET") {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin)
        return yield* Effect.fail(
          new Problem(403, "Cross-origin writes are not allowed."),
        );
    }
    if (path === "/git/projects" && method === "GET")
      return json({ projects: (o.git ?? []).map((g) => g.project) });
    const gitRoute = path.match(/^\/git\/projects\/([a-z0-9-]+)(?:\/(commits|branches|reviews|artifacts)(?:\/([A-Za-z0-9_-]+)(?:\/(decisions|comments))?)?)?$/);
    if(gitRoute) {
      const configured=o.git?.find(g=>g.project.id===gitRoute[1]);
      if(!configured)return yield* Effect.fail(new Problem(404,"Git project is not configured on this instance."));
      const repository=yield* attempt(async()=>configured.onBranch(url.searchParams.get("branch")||configured.project.branch));
      const section=gitRoute[2],id=gitRoute[3],action=gitRoute[4];
      const page=yield* attempt(async()=>decode(z.coerce.number().int().min(1).max(1000),url.searchParams.get("page")||1));
      if(!section&&method==="GET")return json(yield* attempt(()=>repository.snapshot()));
      if(section==="commits"&&!id&&method==="POST") {
        const input=yield* attempt(async()=>decode(gitCommitSchema,await body(request)));
        return json(yield* attempt(()=>repository.commit(input)),201);
      }
      if(section==="branches"&&!id&&method==="POST") {
        const input=yield* attempt(async()=>decode(z.object({name:z.string().min(1).max(200),revision:z.string().regex(/^[a-f0-9]{40}$/)}).strict(),await body(request)));
        return json(yield* attempt(()=>repository.createBranch(input.name,input.revision)),201);
      }
      if(section==="branches"&&!id&&method==="GET") {
        const result=yield* attempt(()=>repository.branches(page));
        if(o.studio)yield* attempt(()=>o.studio!.observe(configured,result.items,[]));
        return json(result);
      }
      if(section==="commits"&&!id&&method==="GET") {
        const result=yield* attempt(()=>repository.history(page));
        if(o.studio)yield* attempt(()=>o.studio!.observe(configured,[],result.items));
        return json(result);
      }
      if(section==="reviews"||section==="artifacts") {
        if(!o.studio)return yield* Effect.fail(new Problem(503,"Studio metadata storage is not configured."));
        const studio=o.studio;
        if(!id&&method==="GET")return json(yield* attempt(()=>studio.list(configured,section==="reviews"?"ChangeReview":"IRArtifact",url.searchParams.get("cursor")||undefined)));
        if(section==="reviews") {
          if(!id&&method==="POST") {
            const input=yield* attempt(async()=>decode(z.object({title:z.string().trim().min(1).max(200),description:z.string().max(4000),baseBranch:z.string().min(1).max(200),headBranch:z.string().min(1).max(200),headRevision:z.string().regex(/^[a-f0-9]{40}$/)}).strict(),await body(request)));
            return json(yield* attempt(()=>studio.submit(configured,input)),201);
          }
          if(id&&!action&&method==="GET")return json(yield* attempt(()=>studio.detail(configured,id)));
          if(id&&action==="decisions"&&method==="POST") {
            const input=yield* attempt(async()=>decode(z.object({action:z.enum(["approve","requestChanges","close"]),expectedVersion:z.number().int().positive()}).strict(),await body(request)));
            return json(yield* attempt(()=>studio.decide(configured,id,input.action,input.expectedVersion)));
          }
          if(id&&action==="comments"&&method==="POST") {
            const input=yield* attempt(async()=>decode(z.object({body:z.string().trim().min(1).max(4000)}).strict(),await body(request)));
            yield* attempt(()=>studio.review(configured,id));
            return json(yield* attempt(()=>studio.call("ReviewComment","create",{review:id,body:input.body,author:"console-administrator"})),201);
          }
        }
        if(section==="artifacts"&&!id&&method==="POST") {
          const input=yield* attempt(async()=>decode(z.object({revision:z.string().regex(/^[a-f0-9]{40}$/),digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),location:z.string().min(1).max(2000).refine(s=>{try{const u=new URL(s);return ["https:","oci:"].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}}),byteCount:z.number().int().nonnegative(),compilerVersion:z.string().min(1).max(100),irVersion:z.string().min(1).max(100)}).strict(),await body(request)));
          yield* attempt(()=>configured.snapshot(input.revision));
          const record=yield* attempt(()=>studio.repository(configured));
          return json(yield* attempt(()=>studio.call("IRArtifact","create",{...input,repository:record.id,key:`${record.id}:${input.revision}:${input.digest}`})),201);
        }
      }
    }
    if(path==='/runtime/targets'&&method==='GET')return json({targets:(o.runtimes||[]).map(t=>t.public)});
    const runtimeRoute=path.match(/^\/runtime\/targets\/([a-z0-9-]+)\/(catalog|invoke|workspace|record)$/);
    if(runtimeRoute){
      const target=o.runtimes?.find(t=>t.public.id===runtimeRoute[1]);
      if(!target)return yield* Effect.fail(new Problem(404,'Runtime is not configured on this instance.'));
      if(method==='GET'&&runtimeRoute[2]==='catalog')return json(yield* attempt(()=>target.catalog()));
      if(method==='GET'&&runtimeRoute[2]==='workspace')return json(yield* attempt(()=>target.workspace()));
      if(method==='POST'&&['invoke','record'].includes(runtimeRoute[2]!)){
        const input=yield* attempt(async()=>decode(z.object({operationId:z.string().min(1).max(300),input:z.record(z.string(),z.unknown()),buildHash:z.string().min(1).max(200),deploymentRevision:z.string().max(200).optional(),purpose:z.string().max(200).optional(),idempotencyKey:z.string().max(200).optional()}).strict(),await body(request)));
        if(runtimeRoute[2] === "record") return json(yield* attempt(()=>target.record(input)));
        return json(yield* attempt(()=>target.invoke(input)));
      }
    }
    if(path==='/deployments/targets'&&method==='GET')return json({targets:(o.deployments||[]).map(t=>t.public)});
    const deploymentRoute=path.match(/^\/deployments\/targets\/([a-z0-9-]+)(\/actions)?$/);
    if(deploymentRoute){
      const target=o.deployments?.find(t=>t.public.id===deploymentRoute[1]);
      if(!target)return yield* Effect.fail(new Problem(404,'Deployment target is not configured on this instance.'));
      if(method==='GET'&&!deploymentRoute[2])return json(yield* attempt(()=>target.inspect()));
      if(method==='POST'&&deploymentRoute[2]){
        const input=yield* attempt(async()=>decode(deploymentAction,await body(request)));
        return json(yield* attempt(()=>target.action(input)),202);
      }
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
    state.audit.unshift({ id: crypto.randomUUID(), at: now, action, subject });
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

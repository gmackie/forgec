import { Layer } from "effect";
import {
  Model,
  Engine,
  createHttpHandler,
  MemoryStorage,
  MemoryObjectStore,
  Clock,
  IdGen,
  Storage,
  Objects,
  CursorSecret,
  err,
  type AppBundle,
} from "@forgegraph/runtime";
import { functions } from "./playground-functions.js";
import bundle from "../generated/playground/app.json";
const model = new Model(bundle as unknown as AppBundle);
// This demo has pure functions only; application resources need retained storage bindings.
export default {
  async fetch(request: Request, env: { RUNTIME_TOKEN: string }) {
    if (new URL(request.url).pathname === "/healthz")
      return Response.json({ status: "ok", provider: "cloudflare" });
    if (!env.RUNTIME_TOKEN || env.RUNTIME_TOKEN.length < 32)
      return new Response(null, { status: 503 });
    const layer = Layer.mergeAll(
      Layer.succeed(Clock)({ now: () => new Date().toISOString() }),
      Layer.succeed(IdGen)({
        next: () => crypto.randomUUID(),
        opId: () => crypto.randomUUID(),
      }),
      Layer.succeed(Storage)(new MemoryStorage()),
      Layer.succeed(Objects)(new MemoryObjectStore()),
      Layer.succeed(CursorSecret)({ key: env.RUNTIME_TOKEN }),
    );
    const handler = createHttpHandler(
      model,
      new Engine(model, layer, { functions }),
      {
        auth: {
          scheme: "bearer",
          async authenticate(req) {
            const digest = async (value: string) =>
              new Uint8Array(
                await crypto.subtle.digest(
                  "SHA-256",
                  new TextEncoder().encode(value),
                ),
              );
            const [a, b] = await Promise.all([
              digest(req.headers.get("authorization") || ""),
              digest("Bearer " + env.RUNTIME_TOKEN),
            ]);
            let diff = 0;
            for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
            return diff === 0
              ? {
                  tenant: "playground",
                  actor: "console-operator",
                  purposes: ["CustomerSupport"],
                }
              : err("Unauthenticated", "Runtime credential required");
          },
        },
      },
    );
    return handler(request);
  },
};

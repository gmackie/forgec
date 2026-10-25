// The manifest pointer's Durable Object (FORG-47; see ./pointer.ts). One object per scope, named
// `pointer:<scope>`. A host script exports this class and binds it as LINKER_POINTER (wrangler:
// `durable_objects.bindings` + a `new_sqlite_classes` migration); other scripts may bind it by
// `script_name`. It holds only the pointer: no module bytes, no stats.
import { DurableObject } from "cloudflare:workers";
import { readPointer, swapPointer, type Pointer, type PointerBody, type PointerStorage, type SwapResult } from "./pointer.ts";

export class ManifestPointer extends DurableObject {
  private get storage(): PointerStorage {
    return this.ctx.storage as unknown as PointerStorage;
  }
  async read(scope: string): Promise<Pointer> {
    return readPointer(this.storage, scope);
  }
  async swap(scope: string, expect: number, body: PointerBody): Promise<SwapResult> {
    return swapPointer(this.storage, scope, expect, body, Date.now());
  }
}

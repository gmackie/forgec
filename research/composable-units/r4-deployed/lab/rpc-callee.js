// FORG-38 lab: the callee of the invocation-limit probe (lab/probe.js is the caller). It stands in for
// FORG-42's shared runtime Worker: no bindings, reached only over the caller's service binding, and
// calling back into stubs the caller passes it (the runtime's `caps`). Every method reports how far it
// got, so a refused call is located exactly rather than surfacing as a bare 500.
import { WorkerEntrypoint } from "cloudflare:workers";

export default class Callee extends WorkerEntrypoint {
  async fetch() {
    return new Response("callee");
  }

  async noop() {
    return 1;
  }

  /** n sequential calls on an RpcTarget stub received as a parameter. */
  async callbacks(caps, n) {
    let done = 0;
    try {
      for (; done < n; done++) await caps.noop();
      return { done };
    } catch (e) {
      return { done, error: String(e) };
    }
  }

  /** n sequential calls on a function stub received as a parameter. */
  async fnCallbacks(fn, n) {
    let done = 0;
    try {
      for (; done < n; done++) await fn(done);
      return { done };
    } catch (e) {
      return { done, error: String(e) };
    }
  }

  /**
   * A call chain: the callee calls back into the caller's stub, which makes a fresh top-level call to
   * this callee, `depth` times. Each level is a new service-binding invocation nested in the last.
   */
  async chain(caps, depth) {
    if (depth <= 0) return { depth: 0 };
    return caps.chain(depth - 1);
  }

  /** The shared-runtime shape: one `serve` call that makes `n` capability callbacks, as FORG-42's runtime does per D1 statement. */
  async serve(caps, n) {
    let done = 0;
    try {
      for (; done < n; done++) await caps.d1(`select ${done}`);
      return { done };
    } catch (e) {
      return { done, error: String(e) };
    }
  }
}

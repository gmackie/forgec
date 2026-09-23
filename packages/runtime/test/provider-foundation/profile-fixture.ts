import { Effect } from 'effect';
import type { CallContext } from '../../src/engine.js';
import { providerEnvironment } from './environment.js';
export const foundationAdapters = ['hosted'];
let sequence = 0;
/** Replacement for the local helper, selected only by the explicit provider config.
 * Each test uses the real selected adapter and a unique tenant, never a local fallback.
 */
export async function foundation(slug: string, adapter: string, _consumer = false) {
  if (adapter !== 'hosted' || slug !== process.env['FORGE_PROVIDER_PROFILE']) throw new Error('Provider fixture/profile mismatch');
  const f = await providerEnvironment();
  const ctx = { tenant: f.tenantPrefix + '-' + (++sequence), actor: 'operator', requestId: 'provider-profile' };
  const call = (operation: string, input: Record<string, unknown>, context: CallContext = ctx) => Effect.runPromise(f.engine.call(operation, input, context));
  return { ...f, ctx, call };
}

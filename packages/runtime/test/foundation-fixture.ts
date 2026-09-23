import { foundation } from "./helpers/foundation.js";
export { foundationAdapters } from "./helpers/foundation.js";
export function consumerFixture(slug: string, adapter: string) {
  return foundation(slug, adapter, true);
}

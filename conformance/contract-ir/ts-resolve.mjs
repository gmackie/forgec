// The vendored sources import `./x.js` the way tsc emits them; under
// `--experimental-strip-types` there is no `.js`, so resolve to the `.ts`.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && specifier.endsWith(".js")) {
        return next(specifier.slice(0, -3) + ".ts", context);
      }
      throw error;
    }
  },
});

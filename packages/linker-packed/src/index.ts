export { checkCapabilities, DENIED_FINDINGS, type Binding, type CapabilityReport } from "./capabilities.ts";
export { bindingOf, link, LINKER, readJsonc, type Environment, type Link, type LinkedScript, type LinkOptions } from "./link.ts";
export { closureOf, LinkError, loadManifest, manifestHashOf, reseal, type Manifest, type ManifestEntryPoint, type ManifestUnit } from "./manifest.ts";
export { fallbackReason, sliceApp, type SliceReport, type SliceSection } from "./slice.ts";
export { applyPlatformRules, perEntryPoint, perEntryPointShared, RESIDUAL, scriptName, single, STRATEGIES, type GroupingStrategy, type Member } from "./strategies.ts";

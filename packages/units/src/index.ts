export { BUNDLER, bundleUnit, SHARED_LIBRARIES, type Finding, type UnitModule } from "./bundle.ts";
export { memoryFiles, nodeFiles, type SourceFiles } from "./files.ts";
export { canonical, digest, gitBlob, sha256, stableJson } from "./hash.ts";
export { locateImpl, locateIn, type ImplSite } from "./locate.ts";
export { lockedLibraries, memoryHost, type Esbuild, type MemoryHostOptions } from "./memory.ts";
export { DEFAULT_POOL, instancePool, type InstancePool, type PoolOptions, type PoolStats } from "./pool.ts";
export { nodeHost, seal, sealWith, writeSealed, type ClosureManifest, type PlannedWit, type Sealed, type SealHost, type SealOptions, type SourceRef, type UnitPlan } from "./seal.ts";
export { componentWorld, normalizedWorld, TRANSPILER, transpileComponent, verifyComponent, type Transpiled, type TranspileOptions } from "./wasm.ts";
export { bindExport, lift, liftFailure, lower, LoweringError, type Lowering, type UnitResult } from "./wit-lowering.ts";

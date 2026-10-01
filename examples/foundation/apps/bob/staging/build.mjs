/** Bundle a staging entrypoint without installing either app into the other. */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(fileURLToPath(new URL('../../../../../',import.meta.url)));
const require=createRequire(resolve(root,'examples/acme/package.json'));
if(!process.argv[2]||!process.argv[3])throw new Error('Usage: node build.mjs <entrypoint> <output.mjs>');
await require('esbuild').build({entryPoints:[resolve(process.argv[2])],outfile:resolve(process.argv[3]),bundle:true,platform:'node',target:'node24',format:'esm',conditions:['source'],external:['pg'],banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});

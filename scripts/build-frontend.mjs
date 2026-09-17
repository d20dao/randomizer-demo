// Bundles ethers 6 and the @d20dao/vrf-sdk helpers the page uses into one browser ES module, and writes
// frontend/networks.json (public network + D20DAO coordinator info for both Arc networks, from scripts/network.mjs).
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicNetworkConfig } from './network.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: [resolve(root, 'frontend/src/sdk-entry.mjs')],
  outfile: resolve(root, 'frontend/vendor/d20-browser.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'external',
  logLevel: 'info',
});
writeFileSync(resolve(root, 'frontend/networks.json'), JSON.stringify(publicNetworkConfig(), null, 2) + '\n');
console.log('Wrote frontend/networks.json');

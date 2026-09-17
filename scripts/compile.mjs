// Compiles contracts/*.sol with solc-js 0.8.28, resolving @d20dao/vrf-sdk imports from node_modules.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sources = {};
for (const file of readdirSync(resolve(root, 'contracts')).filter((f) => f.endsWith('.sol'))) {
  sources[`contracts/${file}`] = { content: readFileSync(resolve(root, 'contracts', file), 'utf8') };
}

const findImports = (path) => {
  // Only package imports are expected; the SDK exports "./contracts/*" as plain files.
  const candidate = resolve(root, 'node_modules', path);
  if (!path.startsWith('@') || path.includes('..') || !existsSync(candidate)) return { error: `Cannot resolve import ${path}` };
  return { contents: readFileSync(candidate, 'utf8') };
};

const input = {
  language: 'Solidity',
  sources,
  settings: {
    // Same optimizer settings and EVM target the SDK uses for its own build (scripts/build.mjs in d20dao/d20-sdk).
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'storageLayout'] } },
  },
};

console.log(`solc ${solc.version()}`);
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
for (const diagnostic of output.errors ?? []) console.error(diagnostic.formattedMessage);
if ((output.errors ?? []).some((d) => d.severity === 'error')) process.exit(1);

mkdirSync(resolve(root, 'artifacts'), { recursive: true });
const artifact = output.contracts['contracts/D20Playground.sol'].D20Playground;
const out = {
  contractName: 'D20Playground',
  compiler: solc.version(),
  abi: artifact.abi,
  bytecode: '0x' + artifact.evm.bytecode.object,
  storageLayout: artifact.storageLayout,
};
writeFileSync(resolve(root, 'artifacts/D20Playground.json'), JSON.stringify(out, null, 2) + '\n');
// Frontend copy of the ABI (loaded by frontend/index.html).
writeFileSync(resolve(root, 'frontend/D20Playground.abi.json'), JSON.stringify(artifact.abi, null, 2) + '\n');
console.log(`D20Playground: ${artifact.evm.bytecode.object.length / 2} bytes init code, ${artifact.evm.deployedBytecode.object.length / 2} bytes runtime`);
console.log('Wrote artifacts/D20Playground.json and frontend/D20Playground.abi.json');

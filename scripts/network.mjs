// Arc networks and the published D20DAO deployment for each one.
// D20DAO values are copied from the public manifests (checked 2026-09-18, after the implementation upgrades of
// 2026-09-17 that @d20dao/vrf-sdk 0.4.0 describes):
//   https://d20dao.org/deployments/arc-testnet.json  (createdAt 2026-09-16T19:05:46Z)
//   https://d20dao.org/deployments/arc-mainnet.json  (createdAt 2026-09-17T00:19:45Z)
// which match the @d20dao/vrf-sdk 0.4.0 README "Deployments" tables. scripts/check-service.mjs re-fetches the manifests
// and reads the chain, so a later upgrade is reported instead of silently trusted.
// RPC endpoints and explorers are listed in the SDK README "Networks" section and in Arc's docs
// (https://docs.arc.io/arc/references/connect-to-arc).

export const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const SHARED_IMPLEMENTATIONS = {
  // "Both networks run the same coordinator and registry implementations." (SDK README); both manifests agree.
  coordinatorImplementation: '0xd20da0DADa4352A1a9722be43a2D85923443458c',
  coordinatorImplementationCodeHash: '0x8c592609fcb15bc512a91a5cdf6b1ddbe994f3a8b30793fc3967a19b69c1cd0d',
  epochImplementation: '0xd20dA048C969e5aDcC703Dfdf8220cc9dCB2f865',
  epochImplementationCodeHash: '0xd41d69a60a991c0384e5ecb959422a5e8964dbfce80b6aeddc95a975b392430f',
};

export const NETWORKS = {
  testnet: {
    key: 'testnet',
    chainId: 5042002,
    name: 'Arc Testnet',
    isMainnet: false,
    defaultRpcUrl: 'https://rpc.testnet.arc.io',
    rpcEnv: 'ARC_TESTNET_RPC_URL',
    explorer: 'https://testnet.arcscan.app',
    faucet: 'https://faucet.circle.com',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    d20: {
      coordinatorProxy: '0xd20DA0FF9087d053f0291524Eac12abA1ADBd945',
      epochRegistryProxy: '0xD20Da00B47A7cD2211dC4683E306913b05903756',
      ...SHARED_IMPLEMENTATIONS,
      manifestUrl: 'https://d20dao.org/deployments/arc-testnet.json',
    },
  },
  mainnet: {
    key: 'mainnet',
    chainId: 5042,
    name: 'Arc Mainnet',
    isMainnet: true,
    defaultRpcUrl: 'https://rpc.mainnet.arc.io',
    rpcEnv: 'ARC_MAINNET_RPC_URL',
    explorer: 'https://explorer.arc.io',
    faucet: null,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    d20: {
      coordinatorProxy: '0xd20da057469C45928912d983F45790C41e290571',
      epochRegistryProxy: '0xd20Da048C1A68fa3Bc0B5f5Bc454D1530062C82D',
      ...SHARED_IMPLEMENTATIONS,
      manifestUrl: 'https://d20dao.org/deployments/arc-mainnet.json',
    },
  },
};

/** Accepts "testnet" | "mainnet" | "5042002" | "5042". */
export function getNetwork(name) {
  const wanted = String(name ?? '').toLowerCase();
  const network = Object.values(NETWORKS).find((n) => n.key === wanted || String(n.chainId) === wanted);
  if (!network) throw new Error(`Unknown network "${name}". Use testnet (5042002) or mainnet (5042).`);
  return network;
}

/** RPC URL for scripts: the per-network environment override, else Arc's public endpoint. */
export function rpcUrlFor(network) {
  return process.env[network.rpcEnv] || network.defaultRpcUrl;
}

/** Reads `--network <name>` / `--network=<name>` from argv, then the NETWORK env var, then `fallback`. */
export function networkArg(argv = process.argv, fallback = 'testnet') {
  const index = argv.findIndex((a) => a === '--network' || a.startsWith('--network='));
  if (index === -1) return process.env.NETWORK || fallback;
  return argv[index].includes('=') ? argv[index].split('=')[1] : argv[index + 1];
}

/** Public, key-free description written to frontend/networks.json. Never includes RPC overrides from the environment. */
export function publicNetworkConfig() {
  return Object.fromEntries(Object.values(NETWORKS).map((n) => [n.chainId, {
    key: n.key,
    chainId: n.chainId,
    name: n.name,
    isMainnet: n.isMainnet,
    rpcUrl: n.defaultRpcUrl,
    explorer: n.explorer,
    faucet: n.faucet,
    nativeCurrency: n.nativeCurrency,
    coordinator: n.d20.coordinatorProxy,
    coordinatorImplementation: n.d20.coordinatorImplementation,
    manifestUrl: n.d20.manifestUrl,
  }]));
}

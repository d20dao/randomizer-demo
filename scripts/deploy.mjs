// Deploys D20Playground to Arc Testnet or Arc Mainnet and records the address for the page.
//
//   npm run deploy:testnet
//   npm run deploy:mainnet                        (pre-flight + cost estimate only; nothing is sent)
//   npm run deploy:mainnet -- --confirm-mainnet   (actually deploys on mainnet)
//
// The deployer key is read only from the PRIVATE_KEY environment variable and is never written anywhere.
// Optional environment:
//   ARC_TESTNET_RPC_URL / ARC_MAINNET_RPC_URL   RPC override for the selected network
//   ALLOW_UNPINNED_COORDINATOR=1                deploy even if the coordinator no longer matches the published manifest
//   D20_DEPLOYMENTS_FILE                        config file to update (default frontend/deployments.json)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, ContractFactory, Contract, formatUnits, getAddress } from 'ethers';
import { getNetwork, networkArg, rpcUrlFor } from './network.mjs';
import { checkService, providerFor } from './check-service.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const network = getNetwork(networkArg(process.argv, 'testnet'));
const confirmedMainnet = process.argv.includes('--confirm-mainnet');
const deploymentsFile = resolve(root, process.env.D20_DEPLOYMENTS_FILE || 'frontend/deployments.json');
const coordinator = network.d20.coordinatorProxy;

const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) {
  console.error(`Set PRIVATE_KEY to a funded ${network.name} key first${network.faucet ? ` (test USDC: ${network.faucet})` : ''}.`);
  console.error(`  PowerShell:  $env:PRIVATE_KEY = "0x..."; npm run deploy:${network.key}`);
  console.error(`  bash:        PRIVATE_KEY=0x... npm run deploy:${network.key}`);
  process.exit(1);
}

const artifact = JSON.parse(readFileSync(resolve(root, 'artifacts/D20Playground.json'), 'utf8'));
const provider = providerFor(network);
const wallet = new Wallet(privateKey, provider);

console.log(`Pre-flight for ${network.name} (read-only):`);
const problems = await checkService(network, provider, { log: (line) => console.log('  ' + line) });
if (problems.length) {
  console.error('\n- ' + problems.join('\n- '));
  if (!process.env.ALLOW_UNPINNED_COORDINATOR) {
    console.error(`\nRefusing to deploy. Review ${network.d20.manifestUrl}, update scripts/network.mjs, or set ALLOW_UNPINNED_COORDINATOR=1.`);
    process.exit(1);
  }
}

const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
const deployTx = await factory.getDeployTransaction(coordinator);
const [balance, gas, feeData] = await Promise.all([
  provider.getBalance(wallet.address),
  provider.estimateGas({ ...deployTx, from: wallet.address }),
  provider.getFeeData(),
]);
const pricePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
const maxCost = gas * pricePerGas;
console.log(`\nDeployer ${wallet.address}`);
console.log(`  balance            ${formatUnits(balance, 18)} USDC`);
console.log(`  deployment gas     ${gas} at up to ${formatUnits(pricePerGas, 'gwei')} gwei = at most ${formatUnits(maxCost, 18)} USDC`);
console.log(`  coordinator        ${coordinator}`);
console.log(`  config file        ${deploymentsFile}`);
if (balance < maxCost) {
  console.error(`\nInsufficient balance for deployment on ${network.name}.${network.faucet ? ` Fund it at ${network.faucet}.` : ''}`);
  process.exit(1);
}
if (network.isMainnet && !confirmedMainnet) {
  console.log('\nArc Mainnet uses real USDC. Nothing was sent. To deploy, run:\n  npm run deploy:mainnet -- --confirm-mainnet');
  process.exit(2);
}

const contract = await factory.deploy(coordinator);
const tx = contract.deploymentTransaction();
console.log(`\nDeploy tx ${tx.hash}\n  ${network.explorer}/tx/${tx.hash}`);
const receipt = await tx.wait();
if (receipt.status !== 1) throw new Error('Deployment transaction failed');
const address = getAddress(await contract.getAddress());

// Post-deploy sanity: code present and wired to the published coordinator.
const deployed = new Contract(address, artifact.abi, provider);
const [rng, callbackGas] = await Promise.all([deployed.rng(), deployed.CALLBACK_GAS()]);
if (getAddress(rng) !== getAddress(coordinator)) throw new Error(`Deployed contract points at ${rng}, expected ${coordinator}`);
console.log(`D20Playground deployed at ${address} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})\n  ${network.explorer}/address/${address}`);

const deployments = existsSync(deploymentsFile) ? JSON.parse(readFileSync(deploymentsFile, 'utf8')) : {};
deployments[network.chainId] = {
  network: network.key,
  name: network.name,
  chainId: network.chainId,
  address,
  coordinator,
  callbackGas: Number(callbackGas),
  deployer: wallet.address,
  transactionHash: tx.hash,
  blockNumber: receipt.blockNumber,
  compiler: artifact.compiler,
  rpcUsed: rpcUrlFor(network) === network.defaultRpcUrl ? network.defaultRpcUrl : 'custom (ARC_*_RPC_URL)',
  deployedAt: new Date().toISOString(),
};
writeFileSync(deploymentsFile, JSON.stringify(deployments, null, 2) + '\n');
console.log(`\nUpdated ${deploymentsFile} for chain ${network.chainId}. Next: npm run serve, then open http://localhost:5173/?network=${network.key}`);

// Read-only pre-flight for one or both Arc networks. Sends no transaction and needs no key.
//   node scripts/check-service.mjs --network testnet|mainnet|all
// Checks: chain id; the coordinator proxy's ERC-1967 implementation address and runtime code hash against the pinned
// values in scripts/network.mjs; that the pins still match the published manifest on d20dao.org; live pricing and quote.
import { pathToFileURL } from 'node:url';
import { JsonRpcProvider, Contract, getAddress, keccak256, formatUnits } from 'ethers';
import { coordinatorAbi } from '@d20dao/vrf-sdk/abi';
import { quoteRequestFee } from '@d20dao/vrf-sdk';
import { NETWORKS, ERC1967_IMPLEMENTATION_SLOT, getNetwork, networkArg, rpcUrlFor } from './network.mjs';

export function providerFor(network) {
  return new JsonRpcProvider(rpcUrlFor(network), network.chainId, { staticNetwork: true });
}

/** Returns a list of problems (empty = OK). */
export async function checkService(network, provider = providerFor(network), { log = console.log, callbackGas = 150_000 } = {}) {
  const d20 = network.d20;
  const problems = [];
  log(`network            ${network.name} (${network.key}), RPC ${rpcUrlFor(network)}`);

  const chainId = BigInt(await provider.send('eth_chainId', []));
  log(`chainId            ${chainId}`);
  if (chainId !== BigInt(network.chainId)) problems.push(`expected chain ${network.chainId}, RPC reports ${chainId}`);

  try {
    const manifest = await fetch(d20.manifestUrl).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    const mismatches = [
      ['chainId', manifest.chainId, network.chainId],
      ['coordinator', manifest.coordinator, d20.coordinatorProxy],
      ['registry', manifest.registry, d20.epochRegistryProxy],
      ['coordinatorImplementation', manifest.coordinatorImplementation, d20.coordinatorImplementation],
      ['coordinatorImplementationCodeHash', manifest.coordinatorImplementationCodeHash, d20.coordinatorImplementationCodeHash],
    ].filter(([, published, pinned]) => String(published).toLowerCase() !== String(pinned).toLowerCase());
    const upgrades = manifest.implementationUpgrades?.length ?? 0;
    log(`manifest           ${d20.manifestUrl}: ${mismatches.length ? 'DIFFERS from pins' : 'matches pins'}, ${upgrades} recorded upgrade(s)`);
    for (const [field, published, pinned] of mismatches) problems.push(`published manifest ${field} is ${published}, pinned ${pinned}`);
  } catch (error) {
    log(`manifest           could not fetch ${d20.manifestUrl} (${error.message}); relying on on-chain checks only`);
  }

  const implementation = getAddress('0x' + (await provider.getStorage(d20.coordinatorProxy, ERC1967_IMPLEMENTATION_SLOT)).slice(26));
  const codeHash = keccak256(await provider.getCode(implementation));
  const implOk = implementation === getAddress(d20.coordinatorImplementation);
  const hashOk = codeHash === d20.coordinatorImplementationCodeHash;
  log(`coordinator proxy  ${d20.coordinatorProxy}`);
  log(`implementation     ${implementation} ${implOk ? '(matches pin)' : '(DIFFERS from pin)'}`);
  log(`runtime code hash  ${codeHash} ${hashOk ? '(matches pin)' : '(DIFFERS from pin)'}`);
  if (!implOk) problems.push('coordinator implementation differs from the pinned manifest value');
  if (!hashOk) problems.push('coordinator implementation code hash differs from the pinned manifest value');

  try {
    const coordinator = new Contract(d20.coordinatorProxy, coordinatorAbi, provider);
    const [minFee, multiplier, overhead] = await coordinator.pricing();
    log(`pricing            minFee ${formatUnits(minFee, 18)} USDC, multiplier ${multiplier}, overhead ${overhead} gas`);
    log(`nextRequestId      ${await coordinator.nextRequestId()}`);
    const quote = await quoteRequestFee(provider, d20.coordinatorProxy, callbackGas);
    log(`quote              ${callbackGas} callback gas at block ${quote.blockNumber}, baseFee ${formatUnits(quote.baseFee, 'gwei')} gwei: fee ${formatUnits(quote.fee, 18)} USDC, send ${formatUnits(quote.value, 18)} USDC`);
  } catch (error) {
    problems.push(`coordinator reads failed: ${error.shortMessage ?? error.message}`);
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const selected = networkArg(process.argv, 'all');
  const networks = selected === 'all' ? Object.values(NETWORKS) : [getNetwork(selected)];
  let failed = false;
  for (const network of networks) {
    const problems = await checkService(network);
    if (problems.length) {
      failed = true;
      console.error(`PROBLEMS on ${network.name}:\n- ${problems.join('\n- ')}\n`);
    } else {
      console.log(`OK: ${network.name} coordinator matches the published deployment.\n`);
    }
  }
  process.exit(failed ? 1 : 0);
}

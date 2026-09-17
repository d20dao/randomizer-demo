// End-to-end test on local chains. Nothing touches a live network except read-only fetches of the published manifests
// (by the deploy pre-flight) and of the coordinator implementation's runtime code (so the pinned code-hash check runs for real).
//
//   node test/local-e2e.mjs            compile, start local Arc Testnet (5042002) and Arc Mainnet (5042) chains, deploy with
//                                      scripts/deploy.mjs, request every option from two wallets, fulfill, verify stored state
//   node test/local-e2e.mjs --keep     same, then keep both chains and the static server running for the page (Ctrl+C stops)
//   node test/local-e2e.mjs request --network testnet --options d20,shuffle   (while --keep runs) request as a new wallet
//   node test/local-e2e.mjs keeper --network testnet                          (while --keep runs) fulfill pending requests
//
// Local chains: Hardhat nodes on 127.0.0.1:18545 (testnet id) and :18546 (mainnet id). The D20DAO coordinator proxy address of
// each network gets test/MockCoordinator.sol as code; the pinned implementation address gets the real implementation code.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { AbiCoder, Contract, Interface, JsonRpcProvider, Wallet, getAddress, hexlify, keccak256, randomBytes, toBeHex, zeroPadValue, id as ethersId, formatUnits } from 'ethers';
import { builtins, mapRandomness, quoteRequestFee } from '@d20dao/vrf-sdk';
import { NETWORKS, ERC1967_IMPLEMENTATION_SLOT, getNetwork, networkArg } from '../scripts/network.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = { testnet: { port: 18545 }, mainnet: { port: 18546 } };
const localUrl = (key) => `http://127.0.0.1:${LOCAL[key].port}`;
const DEPLOYMENTS_NAME = 'deployments.local-test.json';
const DEPLOYMENTS_FILE = resolve(root, 'frontend', DEPLOYMENTS_NAME);
const abiCoder = AbiCoder.defaultAbiCoder();
const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'full';

// ------------------------------------------------------------------ shared helpers
function compileMock() {
  const input = {
    language: 'Solidity',
    sources: { 'MockCoordinator.sol': { content: readFileSync(resolve(root, 'test/MockCoordinator.sol'), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.deployedBytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: (p) => ({ contents: readFileSync(resolve(root, 'node_modules', p), 'utf8') }) }));
  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts['MockCoordinator.sol'].MockCoordinator;
  return { abi: c.abi, runtime: '0x' + c.evm.deployedBytecode.object };
}

const loadArtifact = () => JSON.parse(readFileSync(resolve(root, 'artifacts/D20Playground.json'), 'utf8'));
const providerFor = (key) => new JsonRpcProvider(localUrl(key), getNetwork(key).chainId, { staticNetwork: true, pollingInterval: 250, cacheTimeout: -1 });

async function fundedWallet(provider, usdc = 1000n) {
  const wallet = Wallet.createRandom().connect(provider);
  await provider.send('hardhat_setBalance', [wallet.address, toBeHex(usdc * 10n ** 18n)]);
  return wallet;
}

const LABEL = ethersId('local-e2e');
const OPTION_TABLE = [
  ['raw', 'requestRaw', () => [LABEL], 0, () => builtins.raw()],
  ['d20', 'rollD20', () => [LABEL], 1, () => builtins.d20()],
  ['d12', 'rollD12', () => [LABEL], 2, () => builtins.d12()],
  ['d10', 'rollD10', () => [LABEL], 3, () => builtins.d10()],
  ['d8', 'rollD8', () => [LABEL], 4, () => builtins.d8()],
  ['d6', 'rollD6', () => [LABEL], 5, () => builtins.d6()],
  ['d4', 'rollD4', () => [LABEL], 6, () => builtins.d4()],
  ['dN', 'rollDN', () => [100n, LABEL], 7, () => builtins.dN(100n)],
  ['dice', 'rollDice', () => [6n, 4, LABEL], 8, () => builtins.diceRoll(6n, 4)],
  ['coin', 'flipCoin', () => [LABEL], 9, () => builtins.coinFlip()],
  ['range', 'randomInRange', () => [10n, 1_000_000n, LABEL], 10, () => builtins.numberRange(10n, 1_000_000n)],
  ['one', 'chooseOne', (items) => [items], 11, (items) => builtins.chooseOne(items.length)],
  ['many', 'chooseMany', (items) => [items, 3], 12, (items) => builtins.chooseMany(items.length, 3)],
  ['shuffle', 'shuffle', (items) => [items], 13, (items) => builtins.shuffle(items.length)],
].map(([key, fn, args, kind, spec]) => ({ key, fn, args, kind, spec }));
const DEFAULT_ITEMS = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Heidi'];

function contracts(key, signer) {
  const artifact = loadArtifact();
  const network = getNetwork(key);
  const deployments = JSON.parse(readFileSync(DEPLOYMENTS_FILE, 'utf8'));
  const address = deployments[network.chainId]?.address;
  if (!address) throw new Error(`No ${key} address in ${DEPLOYMENTS_FILE}`);
  const mock = compileMock();
  const errorAbi = [...mock.abi.filter((i) => i.type === 'error'), { type: 'error', name: 'InvalidMapping', inputs: [] }]
    .filter((e) => !artifact.abi.some((a) => a.type === 'error' && a.name === e.name));
  const iface = new Interface([...artifact.abi, ...errorAbi]);
  return {
    network, address, iface,
    playground: new Contract(address, iface, signer),
    coordinator: new Contract(network.d20.coordinatorProxy, mock.abi, signer),
  };
}

async function request(c, wallet, option, items = DEFAULT_ITEMS, extraValue = 0n) {
  const provider = wallet.provider;
  const callbackGas = await c.playground.CALLBACK_GAS();
  const quote = await quoteRequestFee(provider, c.network.d20.coordinatorProxy, callbackGas, { bufferBps: 3000 });
  const tx = await c.playground.connect(wallet)[option.fn](...option.args(items), { value: quote.value + extraValue });
  const receipt = await tx.wait();
  const parsed = receipt.logs.filter((l) => l.address === c.address).map((l) => c.iface.parseLog(l)).filter(Boolean);
  const requestId = parsed.find((p) => p.name === 'JobRequested').args.requestId;
  const itemsEvent = parsed.find((p) => p.name === 'ItemsCommitted');
  return { requestId, receipt, value: quote.value + extraValue, itemsEvent };
}

async function fulfill(c, keeper, requestId, { word = hexlify(randomBytes(32)), deliveryGas } = {}) {
  const coordinator = c.coordinator.connect(keeper);
  const tx = deliveryGas
    ? await coordinator.fulfillWithDeliveryGas(requestId, word, deliveryGas, { gasLimit: 2_000_000 })
    : await coordinator.fulfill(requestId, word, { gasLimit: 2_000_000 });
  const receipt = await tx.wait();
  const logs = receipt.logs.map((l) => { try { return coordinator.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
  return {
    word, receipt,
    delivered: logs.find((l) => l.name === 'CallbackAttempted').args.success,
    gasUsed: logs.find((l) => l.name === 'CallbackGasUsed').args.gasUsed,
  };
}

const plain = (r) => ({
  requestId: r.requestId, requester: r.requester, kind: Number(r.kind), status: Number(r.status), fulfilledBlock: Number(r.fulfilledBlock),
  context: r.context, word: r.word,
  spec: { operation: Number(r.spec.operation), lower: r.spec.lower, upper: r.spec.upper, count: Number(r.spec.count), population: Number(r.spec.population) },
  values: Array.from(r.mappedValues, BigInt),
});
const sameSpec = (a, b) => a.operation === Number(b.operation) && a.lower === BigInt(b.lower) && a.upper === BigInt(b.upper) && a.count === Number(b.count) && a.population === Number(b.population);

async function waitForNode(url, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if (res.ok) return BigInt((await res.json()).result);
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Local node at ${url} did not start`);
}

// ------------------------------------------------------------------ subcommands for a running --keep environment
if (command === 'request' || command === 'keeper') {
  const key = getNetwork(networkArg(process.argv, 'testnet')).key;
  const provider = providerFor(key);
  const wallet = await fundedWallet(provider);
  const c = contracts(key, wallet);
  if (command === 'request') {
    const index = argv.indexOf('--options');
    const wanted = (index === -1 ? 'd20' : argv[index + 1]).split(',');
    for (const optionKey of wanted) {
      const option = OPTION_TABLE.find((o) => o.key === optionKey);
      if (!option) throw new Error(`Unknown option ${optionKey}; use ${OPTION_TABLE.map((o) => o.key).join(',')}`);
      const { requestId } = await request(c, wallet, option, ['North', 'East', 'South', 'West', 'Up', 'Down']);
      console.log(`requested ${optionKey} as ${wallet.address}: request #${requestId}`);
    }
  } else {
    for (const requestId of await c.coordinator.pendingIds()) {
      const { delivered, gasUsed } = await fulfill(c, wallet, requestId);
      console.log(`fulfilled #${requestId} (callback delivered=${delivered}, gas ${gasUsed})`);
    }
  }
  process.exit(0);
}

// ------------------------------------------------------------------ full run
let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' - ' + detail : ''}`);
  return ok;
};
const children = [];
const stopAll = () => { for (const child of children) { try { child.kill(); } catch { /* already gone */ } } };
process.on('SIGINT', () => { stopAll(); process.exit(130); });

console.log('Build:');
for (const script of ['scripts/compile.mjs', 'scripts/build-frontend.mjs']) {
  const res = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  check(`node ${script}`, res.status === 0, res.status === 0 ? '' : res.stderr || res.stdout);
}
const artifact = loadArtifact();
const mock = compileMock();
check('MockCoordinator compiles', mock.runtime.length > 2);

rmSync(DEPLOYMENTS_FILE, { force: true });
const liveImplementationCode = await new JsonRpcProvider(NETWORKS.testnet.defaultRpcUrl, NETWORKS.testnet.chainId, { staticNetwork: true })
  .getCode(NETWORKS.testnet.d20.coordinatorImplementation); // read-only
check('fetched live coordinator implementation code (read-only)', keccak256(liveImplementationCode) === NETWORKS.testnet.d20.coordinatorImplementationCodeHash);

const hardhatCli = resolve(root, 'node_modules/hardhat/internal/cli/bootstrap.js');
try {
  for (const key of ['testnet', 'mainnet']) {
    const network = getNetwork(key);
    console.log(`\n=== Local ${network.name} chain (id ${network.chainId}) at ${localUrl(key)}`);
    const child = spawn(process.execPath, [hardhatCli, '--config', 'test/hardhat.config.cjs', 'node', '--hostname', '127.0.0.1', '--port', String(LOCAL[key].port)],
      { cwd: root, env: { ...process.env, LOCAL_CHAIN_ID: String(network.chainId) }, stdio: 'ignore' });
    children.push(child);
    check('local node started with the network chain id', (await waitForNode(localUrl(key))) === BigInt(network.chainId));
    const provider = providerFor(key);

    // Service: mock at the published coordinator proxy address, real implementation code at the pinned implementation.
    await provider.send('hardhat_setCode', [network.d20.coordinatorImplementation, liveImplementationCode]);
    await provider.send('hardhat_setCode', [network.d20.coordinatorProxy, mock.runtime]);
    await provider.send('hardhat_setStorageAt', [network.d20.coordinatorProxy, ERC1967_IMPLEMENTATION_SLOT, zeroPadValue(network.d20.coordinatorImplementation, 32)]);

    // Deploy through the real deploy script.
    const deployer = await fundedWallet(provider);
    const deployEnv = { ...process.env, PRIVATE_KEY: deployer.privateKey, [network.rpcEnv]: localUrl(key), D20_DEPLOYMENTS_FILE: `frontend/${DEPLOYMENTS_NAME}` };
    delete deployEnv.ALLOW_UNPINNED_COORDINATOR;
    if (network.isMainnet) {
      const dry = spawnSync(process.execPath, ['scripts/deploy.mjs', '--network', key], { cwd: root, env: deployEnv, encoding: 'utf8' });
      const nonce = await provider.getTransactionCount(deployer.address);
      const recorded = existsSync(DEPLOYMENTS_FILE) && JSON.parse(readFileSync(DEPLOYMENTS_FILE, 'utf8'))[network.chainId];
      check('mainnet deploy without --confirm-mainnet stops after pre-flight', dry.status === 2 && nonce === 0 && !recorded, `exit ${dry.status}, nonce ${nonce}`);
    }
    const deploy = spawnSync(process.execPath, ['scripts/deploy.mjs', '--network', key, ...(network.isMainnet ? ['--confirm-mainnet'] : [])], { cwd: root, env: deployEnv, encoding: 'utf8' });
    check(`npm run deploy:${key} (pre-flight: manifest + implementation code hash + pricing)`, deploy.status === 0,
      deploy.status === 0 ? deploy.stdout.split('\n').find((l) => l.startsWith('D20Playground deployed')) : (deploy.stdout + deploy.stderr));
    if (deploy.status !== 0) continue;

    const recorded = JSON.parse(readFileSync(DEPLOYMENTS_FILE, 'utf8'))[network.chainId];
    check(`${DEPLOYMENTS_NAME} records chain ${network.chainId}`, recorded?.chainId === network.chainId && recorded?.coordinator === network.d20.coordinatorProxy, recorded?.address);

    const [walletA, walletB, keeper] = [await fundedWallet(provider), await fundedWallet(provider), await fundedWallet(provider)];
    const c = contracts(key, walletA);
    const callbackGas = await c.playground.CALLBACK_GAS();

    // Fresh contract.
    const fresh = (await c.playground.latestResults()).map(plain);
    check('fresh contract: 14 empty latest results, empty history', fresh.length === 14 && fresh.every((r) => r.requestId === 0n) && (await c.playground.recentResults()).length === 0);

    // Wallet A requests every option.
    console.log('  -- wallet A requests every option');
    const idsA = {};
    let requestChecks = true;
    for (const option of OPTION_TABLE) {
      const { requestId, receipt, itemsEvent } = await request(c, walletA, option, DEFAULT_ITEMS, option.kind % 3 === 0 ? 10n ** 16n : 0n);
      idsA[option.key] = requestId;
      const before = await provider.getBalance(walletA.address, receipt.blockNumber - 1);
      const after = await provider.getBalance(walletA.address, receipt.blockNumber);
      const fee = await c.coordinator.requestFeePaid(requestId);
      const spent = before - after;
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const stored = plain(await c.playground.getResult(requestId));
      const coordinatorSpec = await c.coordinator.getMapping(requestId);
      const itemsOk = !itemsEvent || (keccak256(abiCoder.encode(['string[]'], [[...itemsEvent.args.items]])) === stored.context && [...itemsEvent.args.items].join() === DEFAULT_ITEMS.join());
      const ok = spent === fee + gasCost && (await provider.getBalance(c.address)) === 0n && stored.status === 1 &&
        stored.kind === option.kind && sameSpec(stored.spec, coordinatorSpec) && sameSpec(stored.spec, option.spec(DEFAULT_ITEMS)) && itemsOk;
      if (!ok) requestChecks = check(`request ${option.key}`, false, `spent ${spent} fee ${fee} gas ${gasCost}, status ${stored.status}, items ${itemsOk}`);
    }
    check('14 requests: exact fee charged (change returned), spec stored = coordinator.getMapping, list committed in ItemsCommitted', requestChecks);

    // Keeper fulfills in order; the first fulfilment writes only fresh slots (worst-case callback gas).
    console.log('  -- keeper fulfills A\'s requests');
    const words = {};
    let maxGas = 0n;
    let fulfillChecks = true;
    for (const option of OPTION_TABLE) {
      const requestId = idsA[option.key];
      const { word, receipt, delivered, gasUsed } = await fulfill(c, keeper, requestId);
      words[option.key] = word;
      if (gasUsed > maxGas) maxGas = gasUsed;
      const stored = plain(await c.playground.getResult(requestId));
      const expected = mapRandomness(word, option.spec(DEFAULT_ITEMS));
      const coordinatorValues = (await c.coordinator.getMappedResult(requestId)).map(BigInt);
      const ok = delivered && stored.status === 2 && stored.word === word && stored.fulfilledBlock === receipt.blockNumber &&
        stored.values.join() === expected.join() && coordinatorValues.join() === expected.join();
      if (!ok) fulfillChecks = check(`fulfill ${option.key}`, false, `delivered ${delivered}, values ${stored.values} expected ${expected}`);
    }
    check('14 fulfilments: callback delivered, word/block stored, getResult values = SDK mapRandomness = coordinator.getMappedResult', fulfillChecks);
    check('callback gas within CALLBACK_GAS', maxGas < callbackGas, `max ${maxGas} of ${callbackGas} (includes call overhead)`);

    let latest = (await c.playground.latestResults()).map(plain);
    check('latestResults(): every option shows wallet A\'s request with the correct values',
      OPTION_TABLE.every((o) => latest[o.kind].requestId === idsA[o.key] && latest[o.kind].requester === walletA.address && latest[o.kind].values.join() === mapRandomness(words[o.key], o.spec(DEFAULT_ITEMS)).join()));
    let recent = (await c.playground.recentResults()).map((r) => r.requestId);
    check('recentResults(): 14 entries, newest first', recent.join() === OPTION_TABLE.map((o) => idsA[o.key]).reverse().join());

    // Wallet B: other requester replaces the latest d20 and shuffle.
    console.log('  -- wallet B requests d20 and shuffle');
    const itemsB = ['North', 'East', 'South', 'West'];
    const d20 = OPTION_TABLE.find((o) => o.key === 'd20');
    const shuffle = OPTION_TABLE.find((o) => o.key === 'shuffle');
    const bD20 = (await request(c, walletB, d20, itemsB)).requestId;
    const bShuffle = (await request(c, walletB, shuffle, itemsB)).requestId;
    await fulfill(c, keeper, bD20);
    const { word: bShuffleWord } = await fulfill(c, keeper, bShuffle);
    latest = (await c.playground.latestResults()).map(plain);
    check('latest d20 and shuffle now belong to wallet B; other options unchanged',
      latest[1].requestId === bD20 && latest[1].requester === walletB.address && latest[13].requestId === bShuffle &&
      latest[13].values.join() === mapRandomness(bShuffleWord, builtins.shuffle(4)).join() && latest[5].requestId === idsA.d6);
    const bResult = await c.playground.latestResult(13);
    check('latestResult(Shuffle) = same record', bResult.requestId === bShuffle && bResult.context === keccak256(abiCoder.encode(['string[]'], [itemsB])));

    // Ring buffer wrap: 16 fulfilled so far; 8 more makes 24.
    console.log('  -- 8 more d6 rolls from wallet B (history wraps)');
    const d6 = OPTION_TABLE.find((o) => o.key === 'd6');
    const extra = [];
    for (let i = 0; i < 8; i++) {
      const { requestId } = await request(c, walletB, d6);
      await fulfill(c, keeper, requestId);
      extra.push(requestId);
    }
    const sequence = [...OPTION_TABLE.map((o) => idsA[o.key]), bD20, bShuffle, ...extra];
    recent = (await c.playground.recentResults()).map((r) => r.requestId);
    check('fulfilledCount 24, recentResults() = last 20 newest first', (await c.playground.fulfilledCount()) === 24n && recent.join() === sequence.slice(-20).reverse().join());
    check('latest d6 = last of the 8 rolls', (await c.playground.latestResult(5)).requestId === extra.at(-1));

    // Callback failure then permissionless same-word retry.
    console.log('  -- callback failure + retryCallback');
    const d8 = OPTION_TABLE.find((o) => o.key === 'd8');
    const failId = (await request(c, walletA, d8)).requestId;
    const failed = await fulfill(c, keeper, failId, { deliveryGas: 30_000 });
    const pendingAfterFailure = plain(await c.playground.getResult(failId));
    check('delivery with 30k gas fails; job stays Pending; latest d8 unchanged',
      !failed.delivered && pendingAfterFailure.status === 1 && (await c.playground.latestResult(4)).requestId === idsA.d8);
    await (await c.coordinator.connect(walletB).retryCallback(failId, Number(callbackGas), { gasLimit: 1_000_000 })).wait();
    const retried = plain(await c.playground.getResult(failId));
    check('retryCallback delivers the same word; latest d8 updated', retried.status === 2 && retried.word === failed.word && (await c.playground.latestResult(4)).requestId === failId);

    // Expiry and refund.
    console.log('  -- expiry + refund');
    const coin = OPTION_TABLE.find((o) => o.key === 'coin');
    const countBefore = await c.playground.fulfilledCount();
    const refundId = (await request(c, walletA, coin)).requestId;
    const feePaid = await c.coordinator.requestFeePaid(refundId);
    await provider.send('evm_increaseTime', [61]);
    await provider.send('evm_mine', []);
    let expiredRejected = false;
    try { await c.coordinator.connect(keeper).fulfill.staticCall(refundId, hexlify(randomBytes(32))); } catch (error) { expiredRejected = error.revert?.name === 'RequestExpired'; }
    check('fulfilment after the 60 s deadline is rejected', expiredRejected);
    const refundReceipt = await (await c.coordinator.connect(walletB).refundRequest(refundId, { gasLimit: 500_000 })).wait();
    const aBefore = await provider.getBalance(walletA.address, refundReceipt.blockNumber - 1);
    const aAfter = await provider.getBalance(walletA.address, refundReceipt.blockNumber);
    const refunded = plain(await c.playground.getResult(refundId));
    check('refundRequest (by another wallet): fee returned to requester, _onRefund marks Refunded, history unchanged',
      aAfter - aBefore === feePaid && refunded.status === 3 &&
      (await c.playground.fulfilledCount()) === countBefore && (await c.playground.latestResult(9)).requestId === idsA.coin);

    // Negative paths.
    let spoofRejected = false;
    try { await c.playground.connect(walletB).rawFulfillRandomness.staticCall(idsA.d20, hexlify(randomBytes(32))); } catch (error) { spoofRejected = error.revert?.name === 'OnlyCoordinator'; }
    check('callback from a non-coordinator address rejected (OnlyCoordinator)', spoofRejected);
    let underpayRejected = false;
    try { await c.playground.rollD20.staticCall(LABEL, { value: 0 }); } catch (error) { underpayRejected = error.revert?.name === 'FeeBelowQuote'; }
    check('underpayment rejected (FeeBelowQuote)', underpayRejected);
    let invalidRejected = false;
    try { await c.playground.chooseMany.staticCall(['a', 'b'], 3, { value: 10n ** 17n }); } catch (error) { invalidRejected = error.revert?.name === 'InvalidMapping'; }
    check('invalid mapping rejected (InvalidMapping from the SDK library)', invalidRejected);
    console.log(`  deployed D20Playground ${c.address}; ${await c.playground.requestCount()} requests, ${await c.playground.fulfilledCount()} fulfilled`);
  }
} catch (error) {
  check('unexpected error', false, error.stack);
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll local end-to-end checks passed.');
if (argv.includes('--keep') && !failures) {
  const server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: root, stdio: 'inherit' });
  children.push(server);
  console.log('\nKeeping local chains and the page server running (Ctrl+C to stop):');
  for (const key of ['testnet', 'mainnet']) {
    console.log(`  http://localhost:5173/?network=${key}&rpc=${encodeURIComponent(localUrl(key))}&deployments=${DEPLOYMENTS_NAME}&poll=1500`);
  }
  console.log('  node test/local-e2e.mjs request --network testnet --options d20,shuffle');
  console.log('  node test/local-e2e.mjs keeper --network testnet');
} else {
  stopAll();
  rmSync(DEPLOYMENTS_FILE, { force: true });
  rmSync(resolve(root, 'test/.hardhat'), { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

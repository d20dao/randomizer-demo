// Keyless, fundless dry run against the LIVE D20DAO coordinators on Arc Testnet and/or Arc Mainnet.
//   node scripts/simulate.mjs --network testnet|mainnet|all      (default: all)
// Everything is eth_call / eth_estimateGas with state overrides: a virtual copy of D20Playground at a throwaway address,
// a virtual USDC balance, and virtual contract storage. Nothing is signed or broadcast.
// Per network it checks:
//   - the constructor accepts the coordinator proxy,
//   - every option's request is accepted by the real coordinator (fee paid, mapping validated, epoch checkpoint),
//   - overpayment returns change; underpayment and invalid parameters revert with the documented errors,
//   - coordinator.mapRandomness agrees with the SDK's mapRandomness,
//   - the callback is authenticated and its worst-case (all fresh storage) and steady-state gas fit CALLBACK_GAS,
//   - latestResults()/recentResults()/getResult() over virtual stored results return exactly coordinator.mapRandomness.
// It cannot produce a real VRF result; that needs a funded request and the keeper.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbiCoder, Interface, Contract, ContractFactory, keccak256, hexlify, randomBytes, toBeHex, zeroPadValue, formatUnits, getBytes, id as ethersId } from 'ethers';
import { coordinatorAbi } from '@d20dao/vrf-sdk/abi';
import { builtins, mapRandomness, quoteRequestFee } from '@d20dao/vrf-sdk';
import { NETWORKS, getNetwork, networkArg, rpcUrlFor } from './network.mjs';
import { providerFor } from './check-service.mjs';
import { jobStorage, slotOf } from './storage.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = JSON.parse(readFileSync(resolve(root, 'artifacts/D20Playground.json'), 'utf8'));
const playground = new Interface(artifact.abi);
const abiCoder = AbiCoder.defaultAbiCoder();

const errorFragments = new Map();
for (const item of [...artifact.abi, ...coordinatorAbi, { type: 'error', name: 'InvalidMapping', inputs: [] }]) {
  if (item.type === 'error') errorFragments.set(`${item.name}(${item.inputs.map((i) => i.type).join(',')})`, item);
}
const errors = new Interface([...errorFragments.values()]);
const describeRevert = (data) => {
  if (!data || data === '0x') return 'revert (no data)';
  try {
    const parsed = errors.parseError(data);
    return `${parsed.name}(${parsed.args.map(String).join(', ')})`;
  } catch {
    return `revert ${data}`;
  }
};

const ITEMS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
const LABEL = ethersId('simulate');
// [name, contract function, args, Kind index, SDK spec]
const OPTIONS = [
  ['Raw word', 'requestRaw', [LABEL], 0, builtins.raw()],
  ['d20', 'rollD20', [LABEL], 1, builtins.d20()],
  ['d12', 'rollD12', [LABEL], 2, builtins.d12()],
  ['d10', 'rollD10', [LABEL], 3, builtins.d10()],
  ['d8', 'rollD8', [LABEL], 4, builtins.d8()],
  ['d6', 'rollD6', [LABEL], 5, builtins.d6()],
  ['d4', 'rollD4', [LABEL], 6, builtins.d4()],
  ['dN (d100)', 'rollDN', [100n, LABEL], 7, builtins.dN(100n)],
  ['4d6 dice roll', 'rollDice', [6n, 4, LABEL], 8, builtins.diceRoll(6n, 4)],
  ['coin flip', 'flipCoin', [LABEL], 9, builtins.coinFlip()],
  ['number range 10..100', 'randomInRange', [10n, 100n, LABEL], 10, builtins.numberRange(10n, 100n)],
  ['choose one of 5', 'chooseOne', [ITEMS], 11, builtins.chooseOne(5)],
  ['choose 3 of 5', 'chooseMany', [ITEMS, 3], 12, builtins.chooseMany(5, 3)],
  ['shuffle 5', 'shuffle', [ITEMS], 13, builtins.shuffle(5)],
];

async function simulateNetwork(network) {
  const url = rpcUrlFor(network);
  const provider = providerFor(network);
  const coordinatorAddress = network.d20.coordinatorProxy;
  const coordinator = new Contract(coordinatorAddress, coordinatorAbi, provider);
  let rpcId = 1;
  const rpc = async (method, params) => (await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  })).json();

  const user = hexlify(randomBytes(20));
  const consumer = hexlify(randomBytes(20));
  let failures = 0;
  const pass = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ' - ' + detail : ''}`);
  const fail = (label, detail = '') => { failures++; console.log(`  FAIL  ${label}${detail ? ' - ' + detail : ''}`); };

  console.log(`\n=== ${network.name} (chain ${network.chainId}) via ${url}, coordinator ${coordinatorAddress}`);

  const deployTx = await new ContractFactory(artifact.abi, artifact.bytecode).getDeployTransaction(coordinatorAddress);
  const created = await rpc('eth_call', [{ from: user, data: deployTx.data }, 'latest']);
  if (created.error) { fail('constructor', JSON.stringify(created.error)); return failures; }
  const runtime = created.result;
  pass('constructor accepts the coordinator proxy', `${(runtime.length - 2) / 2} bytes runtime`);

  const overrides = (stateDiff) => ({
    [consumer]: { code: runtime, ...(stateDiff ? { stateDiff } : {}) },
    [user]: { balance: toBeHex(10n ** 21n) },
  });
  const call = (data, value = 0n, from = user, stateDiff) =>
    rpc('eth_call', [{ from, to: consumer, data, value: toBeHex(value) }, 'latest', overrides(stateDiff)]);

  const callbackGas = BigInt(playground.decodeFunctionResult('CALLBACK_GAS', (await call(playground.encodeFunctionData('CALLBACK_GAS'))).result)[0]);
  const quote = await quoteRequestFee(provider, coordinatorAddress, callbackGas);
  console.log(`  quote: ${callbackGas} callback gas, baseFee ${formatUnits(quote.baseFee, 'gwei')} gwei, fee ${formatUnits(quote.fee, 18)} USDC, send ${formatUnits(quote.value, 18)} USDC`);

  console.log('  Requests:');
  for (const [name, fn, args] of OPTIONS) {
    const res = await call(playground.encodeFunctionData(fn, args), quote.value);
    if (res.error) fail(name, describeRevert(res.error.data));
    else pass(name, `accepted, would be request #${BigInt(res.result)}`);
  }
  {
    const overpay = quote.value + 25n * 10n ** 15n;
    const res = await call(playground.encodeFunctionData('rollD6', [LABEL]), overpay);
    if (res.error) fail('overpayment (change returned)', describeRevert(res.error.data));
    else pass('overpayment (change returned)', `sent ${formatUnits(overpay, 18)} USDC`);
  }

  console.log('  Rejected inputs:');
  {
    const res = await call(playground.encodeFunctionData('rollD20', [LABEL]), 0n);
    const text = res.error ? describeRevert(res.error.data) : 'no revert';
    (text.startsWith('FeeBelowQuote') ? pass : fail)('underpayment', text);
  }
  for (const [name, fn, args] of [
    ['dN with 1 side', 'rollDN', [1n, LABEL]],
    ['129 dice', 'rollDice', [6n, 129, LABEL]],
    ['range min > max', 'randomInRange', [5n, 4n, LABEL]],
    ['choose 6 of 5', 'chooseMany', [ITEMS, 6]],
    ['empty list', 'chooseOne', [[]]],
    ['shuffle 257 items', 'shuffle', [Array.from({ length: 257 }, (_, i) => `i${i}`)]],
  ]) {
    const res = await call(playground.encodeFunctionData(fn, args), quote.value);
    const text = res.error ? describeRevert(res.error.data) : 'no revert';
    (text === 'InvalidMapping()' ? pass : fail)(name, text);
  }

  console.log('  Mapping parity (coordinator.mapRandomness vs SDK, 10 random words each):');
  const boundary = [
    ['range full uint256', null, null, null, builtins.numberRange(0n, (1n << 256n) - 1n)],
    ['128d6', null, null, null, builtins.diceRoll(6n, 128)],
    ['shuffle 256', null, null, null, builtins.shuffle(256)],
  ];
  for (const [name, , , , spec] of [...OPTIONS, ...boundary]) {
    let ok = true;
    for (let i = 0; i < 10 && ok; i++) {
      const word = hexlify(randomBytes(32));
      const onchain = (await coordinator.mapRandomness(word, spec)).map(BigInt);
      const offchain = mapRandomness(word, spec);
      if (onchain.join(',') !== offchain.join(',')) { ok = false; fail(name, `word ${word}`); }
    }
    if (ok) pass(name);
  }

  console.log('  Callback (eth_estimateGas from the coordinator address):');
  {
    const requestId = 900_001n;
    const pending = jobStorage(artifact, requestId, { requester: user, kind: 13, status: 1, requestedAt: 1, requestBlock: 1, operation: 6, count: 256, population: 256 });
    const data = playground.encodeFunctionData('rawFulfillRandomness', [requestId, hexlify(randomBytes(32))]);
    const intrinsic = 21_000n + getBytes(data).reduce((sum, b) => sum + (b === 0 ? 4n : 16n), 0n);
    const measure = async (label, stateDiff) => {
      const res = await rpc('eth_estimateGas', [{ from: coordinatorAddress, to: consumer, data }, 'latest', overrides(stateDiff)]);
      if (res.error) { fail(label, `${describeRevert(res.error.data)} ${res.error.message}`); return; }
      const used = BigInt(res.result) - intrinsic;
      (used + 20_000n < callbackGas ? pass : fail)(label, `~${used} gas needed (estimate ${BigInt(res.result)} minus ${intrinsic} intrinsic), CALLBACK_GAS ${callbackGas}`);
    };
    await measure('worst case: first result ever (all fresh slots)', pending);
    const warm = { ...pending,
      [slotOf(artifact, 'fulfilledCount')]: zeroPadValue(toBeHex(41), 32),
      [slotOf(artifact, 'latestIdByKind', 13)]: zeroPadValue(toBeHex(5), 32),
      [slotOf(artifact, 'recentIds', 41 % 20)]: zeroPadValue(toBeHex(7), 32) };
    await measure('steady state: slots already in use', warm);

    const spoof = await call(data, 0n, user, pending);
    const spoofText = spoof.error ? describeRevert(spoof.error.data) : 'no revert';
    (spoofText === 'OnlyCoordinator()' ? pass : fail)('callback from another address rejected', spoofText);
    const unknown = await call(data, 0n, coordinatorAddress);
    const unknownText = unknown.error ? describeRevert(unknown.error.data) : 'no revert';
    (unknownText.startsWith('UnexpectedCallback') ? pass : fail)('callback for an unknown request rejected', unknownText);
  }

  console.log('  Stored-result reads over virtual storage (one fulfilled request per option + 25 in history):');
  {
    const stateDiff = {};
    const words = {};
    const baseId = 700_000n;
    // One fulfilled job per option, registered as that option's latest result.
    for (const [, , , kind, spec] of OPTIONS) {
      const requestId = baseId + BigInt(kind);
      words[requestId] = hexlify(randomBytes(32));
      Object.assign(stateDiff, jobStorage(artifact, requestId, {
        requester: user, kind, status: 2, requestedAt: 1_700_000_000 + kind, fulfilledAt: 1_700_000_010 + kind,
        requestBlock: 100 + kind, fulfilledBlock: 105 + kind, operation: spec.operation, count: spec.count,
        population: spec.population, lower: spec.lower, upper: spec.upper, context: LABEL, word: words[requestId],
      }));
      stateDiff[slotOf(artifact, 'latestIdByKind', kind)] = zeroPadValue(toBeHex(requestId), 32);
    }
    // 25 fulfilments in total: the ring buffer holds the last 20 (ids baseId+kind cycling through the options).
    const total = 25;
    const sequence = Array.from({ length: total }, (_, i) => baseId + BigInt(i % OPTIONS.length));
    sequence.forEach((requestId, i) => { stateDiff[slotOf(artifact, 'recentIds', i % 20)] = zeroPadValue(toBeHex(requestId), 32); });
    stateDiff[slotOf(artifact, 'fulfilledCount')] = zeroPadValue(toBeHex(total), 32);

    const decode = (fn, res) => playground.decodeFunctionResult(fn, res.result)[0];
    const latestRes = await call(playground.encodeFunctionData('latestResults'), 0n, user, stateDiff);
    if (latestRes.error) fail('latestResults()', describeRevert(latestRes.error.data));
    else {
      const latest = decode('latestResults', latestRes);
      let ok = latest.length === OPTIONS.length;
      for (const [name, , , kind, spec] of OPTIONS) {
        const r = latest[kind];
        const expected = (await coordinator.mapRandomness(words[r.requestId], spec)).map(BigInt);
        const got = r.mappedValues.map(BigInt);
        if (r.requestId !== baseId + BigInt(kind) || Number(r.kind) !== kind || Number(r.status) !== 2 ||
            r.requester.toLowerCase() !== user.toLowerCase() || Number(r.fulfilledBlock) !== 105 + kind ||
            got.join(',') !== expected.join(',')) { ok = false; fail(`latestResults()[${name}]`, `got ${got} expected ${expected}`); }
      }
      if (ok) pass('latestResults() returns every option with values equal to coordinator.mapRandomness');
    }
    const recentRes = await call(playground.encodeFunctionData('recentResults'), 0n, user, stateDiff);
    if (recentRes.error) fail('recentResults()', describeRevert(recentRes.error.data));
    else {
      const recent = decode('recentResults', recentRes).map((r) => r.requestId);
      const expected = sequence.slice(-20).reverse();
      (recent.join(',') === expected.join(',') ? pass : fail)('recentResults() = last 20, newest first, after ring wrap', `${recent.length} entries`);
    }
    const emptyRes = await call(playground.encodeFunctionData('latestResults'), 0n, user);
    const empty = emptyRes.error ? null : decode('latestResults', emptyRes);
    (empty && empty.length === 14 && empty.every((r) => r.requestId === 0n) ? pass : fail)('fresh contract: 14 empty latest results');
  }
  return failures;
}

const selected = networkArg(process.argv, 'all');
const networks = selected === 'all' ? Object.values(NETWORKS) : [getNetwork(selected)];
let failures = 0;
for (const network of networks) failures += await simulateNetwork(network);
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed. Nothing was signed or broadcast.');
process.exit(failures ? 1 : 0);

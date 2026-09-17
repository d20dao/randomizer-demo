// Storage-slot helpers for D20Playground, driven by the compiler's storageLayout in artifacts/D20Playground.json.
// Used only by keyless simulations (eth_call state overrides) and the local test.
import { AbiCoder, keccak256, toBeHex, zeroPadValue } from 'ethers';

const abiCoder = AbiCoder.defaultAbiCoder();
const slotHex = (n) => zeroPadValue(toBeHex(n), 32);

function variable(artifact, label) {
  const entry = artifact.storageLayout.storage.find((s) => s.label === label);
  if (!entry) throw new Error(`No storage variable ${label}`);
  return entry;
}

/** Slot of a value variable, or of element `index` of a fixed-size uint256 array. */
export function slotOf(artifact, label, index = 0) {
  return slotHex(BigInt(variable(artifact, label).slot) + BigInt(index));
}

/** stateDiff entries writing `fields` into jobs[requestId]. Missing fields are zero. */
export function jobStorage(artifact, requestId, fields) {
  const jobs = variable(artifact, 'jobs');
  const base = BigInt(keccak256(abiCoder.encode(['uint256', 'uint256'], [requestId, BigInt(jobs.slot)])));
  const structType = artifact.storageLayout.types[jobs.type].value;
  const members = artifact.storageLayout.types[structType].members;
  const slots = new Map();
  for (const member of members) {
    const value = fields[member.label];
    if (value === undefined) continue;
    const bits = BigInt(member.offset) * 8n;
    const slot = base + BigInt(member.slot);
    slots.set(slot, (slots.get(slot) ?? 0n) | (BigInt(value) << bits));
  }
  return Object.fromEntries([...slots].map(([slot, value]) => [slotHex(slot), slotHex(value)]));
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createBlock } from '@ethereumjs/block';
import { Common, Hardfork, Mainnet } from '@ethereumjs/common';
import { bytesToHex, createAddressFromString, hexToBytes } from '@ethereumjs/util';
import { createVM } from '@ethereumjs/vm';
import { Interface, ZeroAddress, getAddress } from 'ethers';
import solc from 'solc';

const ROOT = new URL('../', import.meta.url);
const OWNER = createAddressFromString('0x1000000000000000000000000000000000000001');
const OTHER = createAddressFromString('0x1000000000000000000000000000000000000002');
const START = 1_700_000_000n;
const MIN = 3_600n;
const MAX = 31_536_000n;
const errors = new Interface(['error Error(string)']);

// Compile the real resolved source, not a copy of the implementation.
assert.ok(solc.version().startsWith('0.8.20+'), 'Use the pinned Solidity 0.8.20 compiler');
const sources = Object.fromEntries(
  ['Ktv2OwnershipTimelock.sol', 'tests/MockKtv2.sol'].map((name) => [
    name,
    { content: readFileSync(new URL(name, ROOT), 'utf8') },
  ]),
);
const output = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources,
  settings: {
    evmVersion: 'shanghai',
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
}), {
  import(path) {
    if (!path.startsWith('@openzeppelin/contracts/')) {
      return { error: `Unexpected import: ${path}` };
    }
    try {
      return { contents: readFileSync(new URL(`node_modules/${path}`, ROOT), 'utf8') };
    } catch {
      return { error: `Cannot read dependency: ${path}` };
    }
  },
}));
const compilationErrors = (output.errors ?? []).filter(({ severity }) => severity === 'error');
assert.equal(compilationErrors.length, 0,
  compilationErrors.map(({ formattedMessage }) => formattedMessage).join('\n'));
const artifacts = {
  timelock: output.contracts['Ktv2OwnershipTimelock.sol'].Ktv2OwnershipTimelock,
  ktv2: output.contracts['tests/MockKtv2.sol'].MockKtv2,
};

function assertSuccess(result) {
  assert.equal(result.execResult.exceptionError, undefined,
    `EVM execution failed: ${result.execResult.exceptionError?.error}; ` +
    `return data: ${bytesToHex(result.execResult.returnValue)}`);
  return result;
}

function assertRevert(result, reason) {
  assert.equal(result.execResult.exceptionError?.error, 'revert', `Expected revert: ${reason}`);
  const decoded = errors.parseError(bytesToHex(result.execResult.returnValue));
  assert.equal(decoded.name, 'Error');
  assert.equal(decoded.args[0], reason);
}

function addressOf(contract) {
  return getAddress(contract.address.toString());
}

function emitted(result, contract, name) {
  return (result.execResult.logs ?? [])
    .filter(([address]) => bytesToHex(address) === contract.address.toString())
    .map(([, topics, data]) => contract.interface.parseLog({
      topics: topics.map((topic) => bytesToHex(topic)),
      data: bytesToHex(data),
    }))
    .filter((event) => event?.name === name)
    .map((event) => Array.from(event.args));
}

async function fixture() {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai });
  const vm = await createVM({ common });
  let timestamp = START;
  const block = () => createBlock({
    header: { number: 1n, timestamp, gasLimit: 30_000_000n },
  }, { common });

  async function deploy(artifact, args = []) {
    const iface = new Interface(artifact.abi);
    const result = assertSuccess(await vm.evm.runCall({
      caller: OWNER,
      data: hexToBytes(`0x${artifact.evm.bytecode.object}${iface.encodeDeploy(args).slice(2)}`),
      gasLimit: 10_000_000n,
      block: block(),
    }));
    assert.ok(result.createdAddress, 'Deployment must produce a contract address');
    return { address: result.createdAddress, interface: iface };
  }

  async function attempt(contract, method, args = [], caller = OWNER, isStatic = false) {
    return vm.evm.runCall({
      caller,
      to: contract.address,
      data: hexToBytes(contract.interface.encodeFunctionData(method, args)),
      gasLimit: 10_000_000n,
      block: block(),
      isStatic,
    });
  }

  async function send(contract, method, args = [], caller = OWNER) {
    return assertSuccess(await attempt(contract, method, args, caller));
  }

  async function read(contract, method) {
    const result = assertSuccess(await attempt(contract, method, [], OWNER, true));
    const values = contract.interface.decodeFunctionResult(method, result.execResult.returnValue);
    return values.length === 1 ? values[0] : Array.from(values);
  }

  const ktv2 = await deploy(artifacts.ktv2);
  const timelock = await deploy(artifacts.timelock, [addressOf(ktv2)]);
  return {
    ktv2,
    timelock,
    attempt,
    send,
    read,
    warp(nextTimestamp) {
      assert.ok(nextTimestamp >= timestamp, 'Time must not move backwards');
      timestamp = nextTimestamp;
    },
  };
}

async function prepare(env) {
  await env.send(env.timelock, 'registerOriginalOwner');
  await env.send(env.ktv2, 'transferOwnership', [addressOf(env.timelock)]);
}

async function freeze(env, duration = MIN) {
  await prepare(env);
  return env.send(env.timelock, 'freezeOwnership', [duration]);
}

test('starts inactive with consistent status and rejects operations without a lock', async () => {
  const env = await fixture();
  assert.equal(await env.read(env.ktv2, 'owner'), OWNER.toString());
  assert.equal(await env.read(env.timelock, 'ktv2Contract'), addressOf(env.ktv2));
  assert.equal(await env.read(env.timelock, 'MIN_FREEZE_DURATION'), MIN);
  assert.equal(await env.read(env.timelock, 'MAX_FREEZE_DURATION'), MAX);
  assert.deepEqual(await env.read(env.timelock, 'currentLock'), [ZeroAddress, 0n, false]);
  assert.deepEqual(await env.read(env.timelock, 'getLockStatus'),
    [ZeroAddress, 0n, 0n, false, false, ZeroAddress]);
  assert.equal(await env.read(env.timelock, 'timeUntilRestore'), 0n);
  assert.equal(await env.read(env.timelock, 'canRestore'), false);
  assertRevert(await env.attempt(env.timelock, 'restoreOwnership'), 'No active freeze');
  assertRevert(await env.attempt(env.timelock, 'extendFreeze', [1n]), 'No active freeze');
});

test('freezes ownership with the dev branch lock initialization and event', async () => {
  const env = await fixture();
  const result = await freeze(env);
  assert.deepEqual(await env.read(env.timelock, 'currentLock'),
    [OWNER.toString(), START + MIN, true]);
  assert.equal(await env.read(env.ktv2, 'owner'), addressOf(env.timelock));
  assert.equal(await env.read(env.timelock, 'registeredOwner'), OWNER.toString());
  assert.equal(await env.read(env.timelock, 'timeUntilRestore'), MIN);
  assert.equal(await env.read(env.timelock, 'canRestore'), false);
  assert.deepEqual(await env.read(env.timelock, 'getLockStatus'),
    [OWNER.toString(), START + MIN, MIN, true, false, OWNER.toString()]);
  assert.deepEqual(emitted(result, env.timelock, 'OwnershipFrozen'),
    [[OWNER.toString(), START + MIN, MIN]]);
});

test('requires the current owner to register and transfer ownership before freezing', async () => {
  const env = await fixture();
  assertRevert(await env.attempt(env.timelock, 'registerOriginalOwner', [], OTHER), 'Not Ktv2 owner');
  assertRevert(await env.attempt(env.timelock, 'freezeOwnership', [MIN]), 'Not registered');
  const registered = await env.send(env.timelock, 'registerOriginalOwner');
  assert.deepEqual(emitted(registered, env.timelock, 'OwnerRegistered'), [[OWNER.toString()]]);
  assertRevert(await env.attempt(env.timelock, 'freezeOwnership', [MIN]), 'Transfer ownership first');
  await env.send(env.ktv2, 'transferOwnership', [addressOf(env.timelock)]);
  assertRevert(await env.attempt(env.timelock, 'freezeOwnership', [MIN], OTHER), 'Not registered');
  assert.deepEqual(await env.read(env.timelock, 'currentLock'), [ZeroAddress, 0n, false]);
});

test('enforces freeze duration bounds and accepts both boundary values', async () => {
  for (const duration of [MIN, MAX]) {
    const env = await fixture();
    await prepare(env);
    assertRevert(await env.attempt(env.timelock, 'freezeOwnership', [MIN - 1n]), 'Below minimum');
    assertRevert(await env.attempt(env.timelock, 'freezeOwnership', [MAX + 1n]), 'Exceeds maximum');
    assert.deepEqual(await env.read(env.timelock, 'currentLock'), [ZeroAddress, 0n, false]);
    await env.send(env.timelock, 'freezeOwnership', [duration]);
    assert.deepEqual(await env.read(env.timelock, 'currentLock'),
      [OWNER.toString(), START + duration, true]);
  }
});

test('rejects another freeze and re-registration while frozen', async () => {
  const env = await fixture();
  await freeze(env);
  assertRevert(await env.attempt(env.timelock, 'freezeOwnership', [MIN]), 'Already frozen');
  assertRevert(await env.attempt(env.timelock, 'registerOriginalOwner'), 'Cannot register while frozen');
});

test('extends the deadline using the dev branch calculation and emits the new time', async () => {
  const env = await fixture();
  await freeze(env);
  env.warp(START + 100n);
  const result = await env.send(env.timelock, 'extendFreeze', [600n]);
  assert.deepEqual(await env.read(env.timelock, 'currentLock'),
    [OWNER.toString(), START + MIN + 600n, true]);
  assert.equal(await env.read(env.timelock, 'timeUntilRestore'), MIN + 500n);
  assert.deepEqual(emitted(result, env.timelock, 'FreezeExtended'),
    [[OWNER.toString(), START + MIN + 600n, 600n]]);
});

test('rejects unauthorized, zero, and over-limit extensions without changing the lock', async () => {
  const env = await fixture();
  await freeze(env);
  assertRevert(await env.attempt(env.timelock, 'extendFreeze', [1n], OTHER), 'Not original owner');
  assertRevert(await env.attempt(env.timelock, 'extendFreeze', [0n]), 'Invalid duration');
  assertRevert(await env.attempt(env.timelock, 'extendFreeze', [MAX]), 'Exceeds maximum');
  assert.deepEqual(await env.read(env.timelock, 'currentLock'),
    [OWNER.toString(), START + MIN, true]);
  await env.send(env.timelock, 'extendFreeze', [MAX - MIN]);
  assert.deepEqual(await env.read(env.timelock, 'currentLock'),
    [OWNER.toString(), START + MAX, true]);
  assertRevert(await env.attempt(env.timelock, 'extendFreeze', [1n]), 'Exceeds maximum');
});

test('only the original owner can restore, and only once the deadline is reached', async () => {
  const env = await fixture();
  await freeze(env);
  assertRevert(await env.attempt(env.timelock, 'restoreOwnership'), 'Not expired');
  env.warp(START + MIN);
  assertRevert(await env.attempt(env.timelock, 'restoreOwnership', [], OTHER), 'Not original owner');
  assert.deepEqual(await env.read(env.timelock, 'currentLock'),
    [OWNER.toString(), START + MIN, true]);
  assert.equal(await env.read(env.ktv2, 'owner'), addressOf(env.timelock));
});

test('retains the main branch expiry guard, returning zero at and after expiry', async () => {
  const env = await fixture();
  await freeze(env);
  env.warp(START + MIN - 1n);
  assert.equal(await env.read(env.timelock, 'timeUntilRestore'), 1n);
  assert.equal(await env.read(env.timelock, 'canRestore'), false);
  for (const timestamp of [START + MIN, START + MIN + 1n]) {
    env.warp(timestamp);
    assert.equal(await env.read(env.timelock, 'timeUntilRestore'), 0n);
    assert.equal(await env.read(env.timelock, 'canRestore'), true);
    assert.deepEqual(await env.read(env.timelock, 'getLockStatus'),
      [OWNER.toString(), START + MIN, 0n, true, true, OWNER.toString()]);
  }
});

test('retains main branch restoration cleanup and transfers to the saved original owner', async () => {
  const env = await fixture();
  await freeze(env);
  env.warp(START + MIN);
  const result = await env.send(env.timelock, 'restoreOwnership');
  assert.equal(await env.read(env.ktv2, 'owner'), OWNER.toString());
  assert.deepEqual(await env.read(env.timelock, 'currentLock'), [ZeroAddress, 0n, false]);
  assert.equal(await env.read(env.timelock, 'registeredOwner'), ZeroAddress);
  assert.equal(await env.read(env.timelock, 'timeUntilRestore'), 0n);
  assert.equal(await env.read(env.timelock, 'canRestore'), false);
  assert.deepEqual(await env.read(env.timelock, 'getLockStatus'),
    [ZeroAddress, 0n, 0n, false, false, ZeroAddress]);
  assert.deepEqual(emitted(result, env.timelock, 'OwnershipRestored'),
    [[OWNER.toString(), START + MIN]]);
  assertRevert(await env.attempt(env.timelock, 'restoreOwnership'), 'No active freeze');
  assertRevert(await env.attempt(env.timelock, 'freezeOwnership', [MIN]), 'Not registered');
});

test('supports a new registration and freeze by a different owner after restoration', async () => {
  const env = await fixture();
  await freeze(env);
  env.warp(START + MIN);
  await env.send(env.timelock, 'restoreOwnership');
  await env.send(env.ktv2, 'transferOwnership', [OTHER.toString()]);
  await env.send(env.timelock, 'registerOriginalOwner', [], OTHER);
  await env.send(env.ktv2, 'transferOwnership', [addressOf(env.timelock)], OTHER);
  await env.send(env.timelock, 'freezeOwnership', [MIN], OTHER);
  assert.deepEqual(await env.read(env.timelock, 'currentLock'),
    [OTHER.toString(), START + 2n * MIN, true]);
  assert.equal(await env.read(env.timelock, 'registeredOwner'), OTHER.toString());
});

test('an extension prevents restoration until the extended deadline', async () => {
  const env = await fixture();
  await freeze(env);
  await env.send(env.timelock, 'extendFreeze', [MIN]);
  env.warp(START + MIN);
  assertRevert(await env.attempt(env.timelock, 'restoreOwnership'), 'Not expired');
  assert.equal(await env.read(env.timelock, 'timeUntilRestore'), MIN);
  env.warp(START + 2n * MIN);
  await env.send(env.timelock, 'restoreOwnership');
  assert.equal(await env.read(env.ktv2, 'owner'), OWNER.toString());
  assert.deepEqual(await env.read(env.timelock, 'currentLock'), [ZeroAddress, 0n, false]);
});

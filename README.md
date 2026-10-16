# azmoni — hiring technical test

Manual resolution of the `dev` → `main` merge conflict in the Git repository
inside **`HiringStep (1) (1).zip`**. The original archive is retained unchanged.

## Result

The solution is published on **`arena/8b3a8ad3-azmoni`** in this public repository.
This Arena session is restricted to that branch, so the outer repository's
`main` branch is not modified directly. The archived `main` history was imported
first, then the archived `dev` tip was merged into it and manually resolved.
Both original branch tips are ancestors of the resolution commit; this is an
actual merge, not a replacement of the file with one branch's version.

The other three Solidity contracts are unchanged from the archived branches.

## Confirmed conflict

The ZIP contains an independent Git history, not a remote `dev` branch of this
outer repository:

| Archived ref | Commit |
| --- | --- |
| Common ancestor | `a7863ba82bbb246b4151942633fe333b08be6e7d` |
| `main` | `2a633841b36fd89527ba245b58dbf37237577a2c` |
| `dev` | `deee814173438c3bec8cb052fb76431813234749` |

Both branches added `Ktv2OwnershipTimelock.sol` after the common ancestor.
Running the merge produced exit code **1**, four conflict regions, and:

```text
Auto-merging Ktv2OwnershipTimelock.sol
CONFLICT (add/add): Merge conflict in Ktv2OwnershipTimelock.sol
Automatic merge failed; fix conflicts and then commit the result.
```

`git ls-files -u` confirmed the conflicting blobs:

```text
100644 1c536a7f1cfdc4c81d0e1609f271a7b38327a6e5 2  Ktv2OwnershipTimelock.sol
100644 f0acce32cf89104327efe6f4c89f654b1cf4d538 3  Ktv2OwnershipTimelock.sol
```

## Manual resolution

Each conflict region was inspected and edited explicitly; neither a whole-file
`--ours` nor `--theirs` resolution was used.

| Function | Kept from | Reason |
| --- | --- | --- |
| `freezeOwnership` | `dev` | Initialize the original owner, unlock timestamp, and active flag before emitting `OwnershipFrozen`. |
| `restoreOwnership` | `main` | Save the original owner before deleting `currentLock` and `registeredOwner`, then transfer ownership to that saved address. |
| `extendFreeze` | `dev` | Calculate `newUnlockTime` and enforce the maximum allowed extension before storing it. |
| `timeUntilRestore` | `main` | Return zero for inactive **or expired** locks, preventing Solidity 0.8 subtraction underflow after expiry. |

Selecting just `main` would leave `newUnlockTime` undefined and omit lock
initialization. Selecting just `dev` would leave `owner` undefined, omit
restoration cleanup, and allow the expired-time view to revert.

## Merge procedure

All new commits were made on `arena/8b3a8ad3-azmoni`. After extracting the archive
to a scratch directory, the operations were:

```sh
# Import objects without creating or checking out another branch.
git fetch --no-tags /path/to/HiringStep refs/heads/main refs/heads/dev

# Preserve the outer repository and the independent archived main history.
git merge --allow-unrelated-histories --no-ff \
  2a633841b36fd89527ba245b58dbf37237577a2c \
  -m "Import archived main branch and preserve hiring test history"

# This merge stops with the add/add conflict documented above.
git merge --no-ff --no-commit deee814173438c3bec8cb052fb76431813234749

# Manually edit the four conflict regions, add tests/documentation, then:
git add Ktv2OwnershipTimelock.sol README.md .gitignore package.json package-lock.json tests/
git commit -m "Merge archived dev and manually resolve ownership timelock conflicts"
git push origin arena/8b3a8ad3-azmoni
```

The command block records the procedure; do not rerun the import/merge steps on
the already-resolved branch. Inspect the preserved history with:

```sh
git log --graph --decorate --oneline
```

## Validation

Requires **Node.js 22.12 or newer** and npm:

```sh
npm ci --ignore-scripts
npm test
npm audit
```

The tests compile the actual resolved timelock with **Solidity 0.8.20** and
**OpenZeppelin Contracts 4.9.6**, then execute its bytecode in an isolated,
in-memory EthereumJS EVM using the Shanghai hardfork. No RPC endpoint, wallet,
funds, or external compiler download is needed. Dependencies are pinned and the
compiler's transitive `tmp` dependency is overridden to the patched `0.2.7`.

The 12 regression tests cover lock initialization and emitted events,
registration/custody checks, freeze duration boundaries, active-lock guards,
extension calculation and limits, restoration permissions and timing,
zero remaining time at/after expiry, state cleanup, and a subsequent freeze by
a different owner.

**Scope:** This validates the conflicted timelock using an `Ownable` mock, not a
security audit or a full integration test of the other supplied contracts.
`Ktv2.sol`/`Ktv2Factory.sol` retain their original exact Solidity `0.8.16`
pragmas, and `TokenPrice.sol` retains `0.7.6`; those contracts are intentionally
not changed or compiled by this focused test suite.

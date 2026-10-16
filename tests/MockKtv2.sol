// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

// Only the ownership interface is needed to exercise the timelock.
contract MockKtv2 is Ownable {}

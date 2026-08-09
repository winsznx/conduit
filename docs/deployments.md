# Deployment generations

Core Conduit contracts are **non-upgradeable**. There is no proxy, no admin key
that can change behaviour, and no implementation slot to read. A fix is a new
deployment, and a new deployment is a new generation.

That is why there are three. Each one exists because a real defect was found in
the one before it, and each stays the only generation that can answer for the
settlements it produced — a generation-1 settlement is verifiable against
generation-1 contracts forever, and the canonical generation cannot answer for
it.

Superseded addresses are listed so the record is complete. **Do not send value
to them.**

## Generation 1 — SUPERSEDED

```text
deploymentId  0x9303f240f88e5aba93761e010b75b13681d0c03af58d945c241cc402dadd0843
git commit    a2caa43a016f9c1f01a1b2194a4ae2b0f752c797
solc          0.8.36
deployed      2026-08-08T08:57:01.397Z
manifests     contracts/deployments/base-sepolia-0x9303f240.json, contracts/deployments/monad-testnet-0x9303f240.json
status        SUPERSEDED — DO NOT USE
```

| Chain         | Contract                    | Address                                                                                                                              | Code hash         | Verified source                                                                        |
| ------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------- |
| Base Sepolia  | ConduitRWACVA               | [`0x7a78912533b43C483621200b4919806c0B855E5b`](https://sepolia.basescan.org/address/0x7a78912533b43C483621200b4919806c0B855E5b)      | `0x7ac7b42358fd…` | —                                                                                      |
| Base Sepolia  | RWACVASettlementAdapter     | [`0xE4bA8F4D65F8c62393B47bf47eF6eea8F07F45BE`](https://sepolia.basescan.org/address/0xE4bA8F4D65F8c62393B47bf47eF6eea8F07F45BE)      | `0x715e863143cb…` | —                                                                                      |
| Monad Testnet | SettlementCoordinator       | [`0xE4bA8F4D65F8c62393B47bf47eF6eea8F07F45BE`](https://testnet.monadexplorer.com/address/0xE4bA8F4D65F8c62393B47bf47eF6eea8F07F45BE) | `0x25ef57d0b10c…` | —                                                                                      |
| Monad Testnet | CashEscrow                  | [`0x793c7a8f0c9549ee6cAf7EcC014DDafB7da601EB`](https://testnet.monadexplorer.com/address/0x793c7a8f0c9549ee6cAf7EcC014DDafB7da601EB) | `0x831025f3f3ef…` | —                                                                                      |
| Monad Testnet | ConduitSandboxSettlementCVA | [`0xe32825bb4BF312688233f68aBde3Eb6dCbc89caf`](https://testnet.monadexplorer.com/address/0xe32825bb4BF312688233f68aBde3Eb6dCbc89caf) | `0x17869cb56e2d…` | —                                                                                      |
| Monad Testnet | ConduitVaultRegistrar       | [`0x3FFd39444EBba2307B34c5F36F96e4e04511EBA5`](https://testnet.monadexplorer.com/address/0x3FFd39444EBba2307B34c5F36F96e4e04511EBA5) | `0x1f84807a372a…` | [Sourcify](https://repo.sourcify.dev/10143/0x3FFd39444EBba2307B34c5F36F96e4e04511EBA5) |

## Generation 2 — SUPERSEDED

```text
deploymentId  0x893ca44ecf017ba183180fb358fbc27ed570df9e56d7d35a465a9ed5cb1a9417
git commit    b23cfb87a86d88248c16d7d3be1e3b9cc79b0787
solc          0.8.36
deployed      2026-08-08T14:25:48.128Z
manifests     contracts/deployments/base-sepolia-0x893ca44e.json, contracts/deployments/monad-testnet-0x893ca44e.json
status        SUPERSEDED — DO NOT USE
```

| Chain         | Contract                    | Address                                                                                                                              | Code hash         | Verified source                                                                        |
| ------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------- |
| Base Sepolia  | ConduitRWACVA               | [`0x7a78912533b43C483621200b4919806c0B855E5b`](https://sepolia.basescan.org/address/0x7a78912533b43C483621200b4919806c0B855E5b)      | `0x7ac7b42358fd…` | —                                                                                      |
| Base Sepolia  | RWACVASettlementAdapter     | [`0x51c3D536e94fB5b944c2AF8946d6916543bdf93a`](https://sepolia.basescan.org/address/0x51c3D536e94fB5b944c2AF8946d6916543bdf93a)      | `0x7ecf114b2e08…` | —                                                                                      |
| Monad Testnet | SettlementCoordinator       | [`0x0AEBe99A17796325Da45E49Ef3Ba8BD13bbE5c86`](https://testnet.monadexplorer.com/address/0x0AEBe99A17796325Da45E49Ef3Ba8BD13bbE5c86) | `0xa8998e3674c5…` | —                                                                                      |
| Monad Testnet | CashEscrow                  | [`0xee40c930Be5A67E9fC8F6237E9aca2B94A8Bd85b`](https://testnet.monadexplorer.com/address/0xee40c930Be5A67E9fC8F6237E9aca2B94A8Bd85b) | `0x5284f0fd1164…` | —                                                                                      |
| Monad Testnet | ConduitSandboxSettlementCVA | [`0xe32825bb4BF312688233f68aBde3Eb6dCbc89caf`](https://testnet.monadexplorer.com/address/0xe32825bb4BF312688233f68aBde3Eb6dCbc89caf) | `0x17869cb56e2d…` | —                                                                                      |
| Monad Testnet | ConduitVaultRegistrar       | [`0x3FFd39444EBba2307B34c5F36F96e4e04511EBA5`](https://testnet.monadexplorer.com/address/0x3FFd39444EBba2307B34c5F36F96e4e04511EBA5) | `0x1f84807a372a…` | [Sourcify](https://repo.sourcify.dev/10143/0x3FFd39444EBba2307B34c5F36F96e4e04511EBA5) |

## Generation 3 — CANONICAL

```text
deploymentId  0xdcb9db121ca873817fca7ee6a8e2cd8ef0249b7c83f4e656553338da00eccaa6
git commit    ed413db9f8a6287d72c84db6ee69fe9a8d2d5260
solc          0.8.36
deployed      2026-08-08T19:46:32.821Z
manifests     contracts/deployments/base-sepolia-0xdcb9db12.json, contracts/deployments/monad-testnet-0xdcb9db12.json
status        canonical — every current settlement uses it
```

| Chain         | Contract                    | Address                                                                                                                              | Code hash         | Verified source                                                                        |
| ------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------- |
| Base Sepolia  | ConduitRWACVA               | [`0xDdB1AE5685F4033Ed10B3DfCe5e9dc13D3e4989B`](https://sepolia.basescan.org/address/0xDdB1AE5685F4033Ed10B3DfCe5e9dc13D3e4989B)      | `0x27e4d710348b…` | [Sourcify](https://repo.sourcify.dev/84532/0xDdB1AE5685F4033Ed10B3DfCe5e9dc13D3e4989B) |
| Base Sepolia  | RWACVASettlementAdapter     | [`0xb08bC7F285dd3fC1047798b661E93AB7427a7A61`](https://sepolia.basescan.org/address/0xb08bC7F285dd3fC1047798b661E93AB7427a7A61)      | `0x25e5cbc75faf…` | [Sourcify](https://repo.sourcify.dev/84532/0xb08bC7F285dd3fC1047798b661E93AB7427a7A61) |
| Monad Testnet | SettlementCoordinator       | [`0xb08bC7F285dd3fC1047798b661E93AB7427a7A61`](https://testnet.monadexplorer.com/address/0xb08bC7F285dd3fC1047798b661E93AB7427a7A61) | `0xce2fc566e704…` | [Sourcify](https://repo.sourcify.dev/10143/0xb08bC7F285dd3fC1047798b661E93AB7427a7A61) |
| Monad Testnet | CashEscrow                  | [`0x8151D682836f5B7106181bc8e48DC899ab538930`](https://testnet.monadexplorer.com/address/0x8151D682836f5B7106181bc8e48DC899ab538930) | `0x4751e1ab11db…` | [Sourcify](https://repo.sourcify.dev/10143/0x8151D682836f5B7106181bc8e48DC899ab538930) |
| Monad Testnet | ConduitSandboxSettlementCVA | [`0xFEfd2eA28dB25c720ec5298964F8d2F34e3f1F16`](https://testnet.monadexplorer.com/address/0xFEfd2eA28dB25c720ec5298964F8d2F34e3f1F16) | `0x27e4d710348b…` | [Sourcify](https://repo.sourcify.dev/10143/0xFEfd2eA28dB25c720ec5298964F8d2F34e3f1F16) |
| Monad Testnet | ConduitVaultRegistrar       | [`0x3FFd39444EBba2307B34c5F36F96e4e04511EBA5`](https://testnet.monadexplorer.com/address/0x3FFd39444EBba2307B34c5F36F96e4e04511EBA5) | `0x1f84807a372a…` | [Sourcify](https://repo.sourcify.dev/10143/0x3FFd39444EBba2307B34c5F36F96e4e04511EBA5) |

### Wired after the generation was cut

The disposition kernel was deployed and wired separately, so it is not in the
generation manifest. Its addresses and wiring transactions are recorded in
[`docs/evidence/phase-07-kernel-wiring.json`](./evidence/phase-07-kernel-wiring.json).

| Chain         | Contract              | Address                                                                                                                              | Verified source                                                                        |
| ------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Monad Testnet | AuthorityRegistry     | [`0xEa92410aBCc1712C303174E3a2Cf4FF6Dfc7D1D7`](https://testnet.monadexplorer.com/address/0xEa92410aBCc1712C303174E3a2Cf4FF6Dfc7D1D7) | [Sourcify](https://repo.sourcify.dev/10143/0xEa92410aBCc1712C303174E3a2Cf4FF6Dfc7D1D7) |
| Monad Testnet | DispositionController | [`0x3c4060D402675A25CAd836247CFA0B95614efe81`](https://testnet.monadexplorer.com/address/0x3c4060D402675A25CAd836247CFA0B95614efe81) | [Sourcify](https://repo.sourcify.dev/10143/0x3c4060D402675A25CAd836247CFA0B95614efe81) |
| Base Sepolia  | AuthorityRegistry     | [`0x33BB1eBa633d527f664bEFEd0FD6F13E0bE70E45`](https://sepolia.basescan.org/address/0x33BB1eBa633d527f664bEFEd0FD6F13E0bE70E45)      | [Sourcify](https://repo.sourcify.dev/84532/0x33BB1eBa633d527f664bEFEd0FD6F13E0bE70E45) |
| Base Sepolia  | DispositionController | [`0xEa92410aBCc1712C303174E3a2Cf4FF6Dfc7D1D7`](https://sepolia.basescan.org/address/0xEa92410aBCc1712C303174E3a2Cf4FF6Dfc7D1D7)      | [Sourcify](https://repo.sourcify.dev/84532/0xEa92410aBCc1712C303174E3a2Cf4FF6Dfc7D1D7) |

Policy `0x5eae1a29b5bab0300329f9d58599546ddb24bbbf081f612f6bf762a00f10e2ab`, contest window
300 seconds, four registered authority classes.

## Why each generation was superseded

Generation 1 and generation 2 were replaced because live runs found real
defects, not because of cosmetic changes. The reasoning for each is in the ADRs
and the phase evidence:

| Generation | Superseded because                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1          | the first live HELD-and-disposition path exposed defects in the settlement stack that non-upgradeable contracts could only fix by redeploying |
| 2          | the token itself had to be redeployed, and the projection was left open — `docs/evidence/phase-06-generation-isolation.json`                  |
| 3          | canonical                                                                                                                                     |

Generation isolation is not an assertion. `docs/evidence/phase-06-generation-isolation.json`
records the run that proved a settlement produced under one generation cannot be
answered for by another.

## Verification status

Every canonical address above is checked on every `pnpm verify` run:

```bash
pnpm onchain:check
```

It asserts the address has code, that the on-chain runtime code hash matches the
deployment manifest, and that Sourcify reports a source match. A Sourcify outage
is recorded as `UNKNOWN` and fails the gate rather than passing it. The captured
result, with a timestamp, is
[`docs/evidence/onchain-verification.json`](./evidence/onchain-verification.json).

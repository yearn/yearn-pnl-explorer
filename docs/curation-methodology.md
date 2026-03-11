# Curation Vault Methodology

## Overview

Yearn curation vaults are **MetaMorpho vaults** (ERC4626 wrappers over Morpho Blue lending markets). Yearn acts as a **risk curator** — selecting which Morpho Blue markets vaults allocate to. These vaults are NOT indexed in Kong API and must be tracked via on-chain reads.

## DefiLlama's Approach

DefiLlama's `yearn-curating` adapter dynamically discovers vaults by:
1. Querying Morpho vault factory contracts for creation events
2. Filtering where `initialOwner` (V1) or `owner` (V2) matches Yearn's curator addresses

### Yearn Curator Owner Addresses

| Address | Chains |
|---------|--------|
| `0xFc5F89d29CCaa86e5410a7ad9D9d280d4455C12B` | Ethereum, Base, Katana, Arbitrum, Hyperliquid |
| `0x50B75d586929Ab2F75dC15f07E1B921b7C4Ba8fA` | Ethereum, Base, Katana, Arbitrum, Hyperliquid |
| `0x75a1253432356f90611546a487b5350CEF08780D` | Ethereum, Base, Katana, Arbitrum, Hyperliquid |
| `0x518C21DC88D9780c0A1Be566433c571461A70149` | Katana only |

### Morpho Factory Contracts

**Ethereum:**
- V1: `0xa9c3d3a366466fa809d1ae982fb2c46e5fc41101` (block 18925584)
- V1: `0x1897a8997241c1cd4bd0698647e4eb7213535c24` (block 21439510)
- V2: `0xA1D94F746dEfa1928926b84fB2596c06926C0405` (block 23375073)

**Base:**
- V1: `0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101` (block 13978134)
- V1: `0xFf62A7c278C62eD665133147129245053Bbf5918` (block 23928808)
- V2: `0x4501125508079A99ebBebCE205DeC9593C2b5857` (block 35615206)

**Katana:**
- `0x1c8De6889acee12257899BFeAa2b7e534de32E16` (block 2741420)

**Arbitrum:**
- V1: `0x878988f5f561081deEa117717052164ea1Ef0c82` (block 296447195)
- V2: `0x6b46fa3cc9EBF8aB230aBAc664E37F2966Bf7971` (block 387016724)

**Hyperliquid:**
- `0xec051b19d654C48c357dC974376DeB6272f24e53` (block 1988677)

### Turtle Club Vaults (Ethereum only, hardcoded)

- `0xF470EB50B4a60c9b069F7Fd6032532B8F5cC014d`
- `0xA5DaB32DbE68E6fa784e1e50e4f620a0477D3896`
- `0xe1Ac97e2616Ad80f69f705ff007A4bbb3655544a`
- `0x77570CfEcf83bc6bB08E2cD9e8537aeA9f97eA2F`

## TVL Calculation

1. Call `totalAssets()` on each vault (standard ERC4626)
2. Call `asset()` to get underlying token
3. **Morpho V2 deduplication**: V2 vaults can wrap V1 vaults via a "liquidity adapter." Unique TVL = V1.totalAssets + sum(V2.totalAssets) - sum(V2 deposits in V1)
   - Detect V2 vaults by checking for `liquidityAdapter()` function
   - Resolve underlying V1 via `adapter.morphoVaultV1()`
   - Get adapter share balance in V1: `V1.balanceOf(adapter)` → `V1.convertToAssets(shares)`
   - Subtract from combined total

## Key Notes

- **Double-counted**: DefiLlama marks this as `doublecounted: true` since underlying assets are in Morpho Blue markets
- **~$92M total**: Katana ~$54M, Ethereum ~$32M, Base ~$4M, Arbitrum ~$1M
- **Dynamic discovery preferred** over static list — replicate factory event log queries
- **Five chains**: Ethereum, Base, Katana, Arbitrum, Hyperliquid

# Per-Block Minter

Standalone minting agent that targets contracts with a per-block mint limit. Configured for `0x460d7dfa7aefb52ddb7b87a767485325b31272d9` (18 NFTs/block cap).

## Strategy

- Listens for new blocks and fires all wallet transactions simultaneously at block boundaries
- Fills the 18/block cap by distributing mints across multiple wallets
- Uses aggressive gas pricing to ensure inclusion in the target block
- Continues across consecutive blocks until the target total is reached

## Setup

```bash
cd per-block-minter
npm install
cp .env.example .env
# Edit .env with your MNEMONIC, PROVIDER_URL, and mint settings
```

## Run

```bash
npm start
```

## Configuration

All settings are in `.env`. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MNEMONIC` | — | HD wallet seed phrase (required) |
| `PROVIDER_URL` | — | HTTP RPC endpoint (required) |
| `WS_RPC_URL` | — | WebSocket RPC for fast block detection |
| `TARGET_CONTRACT` | `0x460d...` | NFT contract address |
| `MINT_PRICE_ETH` | `0` | Price per NFT |
| `MINT_QTY_PER_WALLET` | `1` | NFTs each wallet mints per block |
| `WALLETS_PER_BLOCK` | auto (18) | Wallets to fire per block |
| `TOTAL_MINT_TARGET` | `0` (unlimited) | Stop after this many |
| `MAX_BLOCKS` | `50` | Max blocks to attempt |
| `BLOCK_MINT_MAX_FEE_GWEI` | `100` | Max gas fee |
| `BLOCK_MINT_PRIORITY_FEE_GWEI` | `10` | Priority tip |

## How It Works

1. Derives wallets from your mnemonic
2. Checks which wallets are funded (need mint price + ~0.005 ETH gas)
3. Auto-detects the contract's mint function selector
4. Listens for new blocks
5. On each block: fires N wallets simultaneously (N × qty ≤ 18)
6. Reports results and continues to next block

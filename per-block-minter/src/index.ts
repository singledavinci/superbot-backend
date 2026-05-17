/**
 * Per-Block Minter — targets a contract with an 18 NFTs/block limit.
 *
 * Contract: 0x460d7dfa7aefb52ddb7b87a767485325b31272d9
 *
 * Strategy:
 *   - Distributes mints across wallets to fill the 18/block cap each block
 *   - Fires all transactions simultaneously at block boundary to land in the same block
 *   - Supports configurable mint quantity per wallet and total per block
 *   - Uses aggressive gas to ensure inclusion in the target block
 *   - Continues across multiple blocks until target total is reached
 *
 * Usage:
 *   npm start
 */

import { ethers, JsonRpcProvider, Wallet, formatEther, parseEther, parseUnits, WebSocketProvider } from 'ethers';
import * as dotenv from 'dotenv';
dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const TARGET_CONTRACT = process.env.TARGET_CONTRACT || '0x460d7dfa7aefb52ddb7b87a767485325b31272d9';

/** Max NFTs the contract allows per block */
const MAX_PER_BLOCK = 18;

/** How many NFTs each wallet mints per block */
const MINT_QTY_PER_WALLET = parseInt(process.env.MINT_QTY_PER_WALLET || '1', 10);

/** Total NFTs to mint across all blocks (0 = unlimited) */
const TOTAL_TARGET = parseInt(process.env.TOTAL_MINT_TARGET || '0', 10);

/** How many wallets to use per block (auto-calculated if 0) */
const WALLETS_PER_BLOCK = parseInt(process.env.WALLETS_PER_BLOCK || '0', 10) ||
  Math.min(Math.floor(MAX_PER_BLOCK / MINT_QTY_PER_WALLET), 18);

/** Mint price in ETH (set to '0' for free mints) */
const MINT_PRICE_ETH = process.env.MINT_PRICE_ETH || '0';

/** Mint function selector */
const MINT_SELECTOR = process.env.MINT_SELECTOR || '0xa0712d68';

/** If true, auto-detect the mint function via simulation */
const AUTO_DETECT_SELECTOR = process.env.AUTO_DETECT_SELECTOR !== 'false';

/** Gas settings for competitive inclusion */
const MAX_FEE_GWEI = parseFloat(process.env.BLOCK_MINT_MAX_FEE_GWEI || '100');
const PRIORITY_FEE_GWEI = parseFloat(process.env.BLOCK_MINT_PRIORITY_FEE_GWEI || '10');
const GAS_LIMIT = parseInt(process.env.BLOCK_MINT_GAS_LIMIT || '300000', 10);

/** How many blocks to attempt before giving up */
const MAX_BLOCKS = parseInt(process.env.MAX_BLOCKS || '50', 10);

/** Delay after block event before firing (ms) */
const BLOCK_FIRE_DELAY_MS = parseInt(process.env.BLOCK_FIRE_DELAY_MS || '0', 10);

/** Cooldown between blocks (ms) */
const INTER_BLOCK_COOLDOWN_MS = parseInt(process.env.INTER_BLOCK_COOLDOWN_MS || '1000', 10);

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET SETUP
// ═══════════════════════════════════════════════════════════════════════════════

function loadWallets(provider: JsonRpcProvider): Wallet[] {
  const mnemonic = process.env.MNEMONIC;
  const importedKeys = (process.env.IMPORTED_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);

  const wallets: Wallet[] = [];

  if (mnemonic) {
    const hdNode = ethers.HDNodeWallet.fromPhrase(mnemonic);
    const count = Math.max(WALLETS_PER_BLOCK + 2, 20);
    for (let i = 0; i < count; i++) {
      const derived = hdNode.deriveChild(i);
      wallets.push(new Wallet(derived.privateKey, provider));
    }
  }

  for (const key of importedKeys) {
    const pk = key.startsWith('0x') ? key : `0x${key}`;
    wallets.push(new Wallet(pk, provider));
  }

  if (wallets.length === 0) {
    throw new Error('No wallets available. Set MNEMONIC or IMPORTED_KEYS in .env');
  }

  return wallets;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MINT FUNCTION DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

interface MintRoute {
  selector: string;
  encode: (qty: number, walletAddress: string) => string;
  value: (qty: number) => bigint;
  label: string;
}

async function detectMintFunction(provider: JsonRpcProvider, fromAddress: string): Promise<MintRoute> {
  const coder = new ethers.AbiCoder();
  const mintPrice = parseEther(MINT_PRICE_ETH);

  const candidates: MintRoute[] = [
    {
      selector: '0xa0712d68',
      encode: (qty) => '0xa0712d68' + coder.encode(['uint256'], [qty]).slice(2),
      value: (qty) => mintPrice * BigInt(qty),
      label: 'mint(uint256)',
    },
    {
      selector: '0x1249c58b',
      encode: () => '0x1249c58b',
      value: () => mintPrice,
      label: 'mint()',
    },
    {
      selector: '0x40c10f19',
      encode: (qty, addr) => '0x40c10f19' + coder.encode(['address', 'uint256'], [addr, qty]).slice(2),
      value: (qty) => mintPrice * BigInt(qty),
      label: 'mint(address,uint256)',
    },
    {
      selector: '0xefef39a1',
      encode: (qty) => '0xefef39a1' + coder.encode(['uint256', 'uint256'], [qty, MAX_PER_BLOCK]).slice(2),
      value: (qty) => mintPrice * BigInt(qty),
      label: 'mint(uint256,uint256)',
    },
    {
      selector: '0x2db11544',
      encode: (qty) => '0x2db11544' + coder.encode(['uint256'], [qty]).slice(2),
      value: (qty) => mintPrice * BigInt(qty),
      label: 'publicMint(uint256)',
    },
    {
      selector: '0x6a627842',
      encode: (_qty, addr) => '0x6a627842' + coder.encode(['address'], [addr]).slice(2),
      value: () => mintPrice,
      label: 'mint(address)',
    },
  ];

  if (!AUTO_DETECT_SELECTOR) {
    const match = candidates.find(c => c.selector === MINT_SELECTOR);
    if (match) return match;
    return {
      selector: MINT_SELECTOR,
      encode: (qty) => MINT_SELECTOR + coder.encode(['uint256'], [qty]).slice(2),
      value: (qty) => mintPrice * BigInt(qty),
      label: `custom(${MINT_SELECTOR})`,
    };
  }

  console.log('🔍 Auto-detecting mint function...');

  // Try with configured price
  for (const candidate of candidates) {
    try {
      const data = candidate.encode(1, fromAddress);
      const value = candidate.value(1);
      await provider.estimateGas({
        to: TARGET_CONTRACT,
        data,
        value: '0x' + value.toString(16),
        from: fromAddress,
      });
      console.log(`✅ Detected: ${candidate.label}`);
      return candidate;
    } catch {
      // Try next
    }
  }

  // Try as free mint (value = 0)
  for (const candidate of candidates) {
    try {
      const data = candidate.encode(1, fromAddress);
      await provider.estimateGas({
        to: TARGET_CONTRACT,
        data,
        value: '0x0',
        from: fromAddress,
      });
      console.log(`✅ Detected (free): ${candidate.label}`);
      return { ...candidate, value: () => 0n, label: candidate.label + ' [FREE]' };
    } catch {
      // Try next
    }
  }

  throw new Error(
    'Could not detect mint function. Set MINT_SELECTOR and AUTO_DETECT_SELECTOR=false manually.'
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PER-BLOCK EXECUTION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

interface BlockMintResult {
  blockNumber: number;
  attempted: number;
  succeeded: number;
  failed: number;
  txHashes: string[];
  errors: string[];
}

async function mintInBlock(
  wallets: Wallet[],
  mintRoute: MintRoute,
  provider: JsonRpcProvider,
  blockNumber: number,
): Promise<BlockMintResult> {
  const result: BlockMintResult = {
    blockNumber,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    txHashes: [],
    errors: [],
  };

  // Pre-fetch nonces for all wallets in parallel
  const nonces = await Promise.all(
    wallets.map(w => provider.getTransactionCount(w.address, 'pending'))
  );

  // Build and fire all transactions simultaneously
  const maxFee = parseUnits(MAX_FEE_GWEI.toString(), 'gwei');
  const priorityFee = parseUnits(PRIORITY_FEE_GWEI.toString(), 'gwei');

  const txPromises: Promise<{ status: string; hash?: string; error?: string; wallet: string }>[] = [];

  for (let i = 0; i < wallets.length; i++) {
    const wallet = wallets[i];
    const nonce = nonces[i];
    const data = mintRoute.encode(MINT_QTY_PER_WALLET, wallet.address);
    const value = mintRoute.value(MINT_QTY_PER_WALLET);

    result.attempted++;

    txPromises.push(
      wallet.sendTransaction({
        to: TARGET_CONTRACT,
        data,
        value,
        nonce,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: priorityFee,
        gasLimit: BigInt(GAS_LIMIT),
        type: 2,
      }).then(
        (sentTx) => ({ status: 'ok', hash: sentTx.hash, wallet: wallet.address }),
        (err: Error) => ({ status: 'err', error: err.message || String(err), wallet: wallet.address })
      )
    );
  }

  const results = await Promise.all(txPromises);

  for (const r of results) {
    if (r.status === 'ok') {
      result.succeeded++;
      result.txHashes.push(r.hash!);
    } else {
      result.failed++;
      result.errors.push(`${r.wallet.slice(0, 10)}: ${(r.error || '').slice(0, 80)}`);
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  PER-BLOCK MINTER — 18 NFTs/Block Strategy');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Target:          ${TARGET_CONTRACT}`);
  console.log(`  Max/Block:       ${MAX_PER_BLOCK}`);
  console.log(`  Qty/Wallet:      ${MINT_QTY_PER_WALLET}`);
  console.log(`  Wallets/Block:   ${WALLETS_PER_BLOCK}`);
  console.log(`  NFTs/Block:      ${WALLETS_PER_BLOCK * MINT_QTY_PER_WALLET}`);
  console.log(`  Mint Price:      ${MINT_PRICE_ETH} ETH`);
  console.log(`  Total Target:    ${TOTAL_TARGET || 'unlimited'}`);
  console.log(`  Max Blocks:      ${MAX_BLOCKS}`);
  console.log(`  Gas:             ${MAX_FEE_GWEI} gwei max / ${PRIORITY_FEE_GWEI} gwei priority`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // Setup provider
  const rpcUrl = process.env.PROVIDER_URL?.split(',')[0]?.trim();
  if (!rpcUrl) throw new Error('PROVIDER_URL not set in .env');
  const provider = new JsonRpcProvider(rpcUrl);

  const network = await provider.getNetwork();
  console.log(`🌐 Connected to chain ${network.chainId} (${network.name})`);

  // Load wallets
  const allWallets = loadWallets(provider);
  console.log(`👛 Loaded ${allWallets.length} wallets\n`);

  // Check balances
  console.log('💰 Checking wallet balances...');
  const fundedWallets: Wallet[] = [];
  const mintValue = parseEther(MINT_PRICE_ETH) * BigInt(MINT_QTY_PER_WALLET);
  const minRequired = mintValue + parseEther('0.005');

  for (let i = 0; i < Math.min(allWallets.length, WALLETS_PER_BLOCK + 5); i++) {
    const w = allWallets[i];
    const bal = await provider.getBalance(w.address);
    const funded = bal >= minRequired;
    if (funded) fundedWallets.push(w);
    console.log(`  ${funded ? '✅' : '❌'} ${w.address} — ${formatEther(bal).slice(0, 10)} ETH`);
  }

  if (fundedWallets.length === 0) {
    console.error('\n❌ No funded wallets. Fund at least one wallet and retry.');
    process.exit(1);
  }

  console.log(`\n✅ ${fundedWallets.length} funded wallets ready`);

  // Detect mint function
  const mintRoute = await detectMintFunction(provider, fundedWallets[0].address);
  console.log(`\n🎯 Mint route: ${mintRoute.label}`);
  console.log(`   Selector:  ${mintRoute.selector}`);
  console.log(`   Value/tx:  ${formatEther(mintRoute.value(MINT_QTY_PER_WALLET))} ETH\n`);

  // ── Block-by-block execution ──
  let totalMinted = 0;
  let blocksUsed = 0;
  const allResults: BlockMintResult[] = [];

  // Use WebSocket for fastest block detection if available
  const wsUrl = process.env.WS_RPC_URL;
  const blockProvider: JsonRpcProvider | WebSocketProvider = wsUrl
    ? new WebSocketProvider(wsUrl)
    : provider;

  if (wsUrl) {
    console.log('⚡ Using WebSocket for block detection (fastest path)');
  } else {
    console.log('📡 Using HTTP polling for block detection (set WS_RPC_URL for faster)');
  }

  console.log('⏳ Waiting for next block to start minting...\n');

  return new Promise<void>((resolve) => {
    let processing = false;

    const onBlock = async (blockNumber: number) => {
      if (processing) return;
      processing = true;

      try {
        if (TOTAL_TARGET > 0 && totalMinted >= TOTAL_TARGET) {
          finish();
          return;
        }
        if (blocksUsed >= MAX_BLOCKS) {
          finish();
          return;
        }

        if (BLOCK_FIRE_DELAY_MS > 0) {
          await new Promise(r => setTimeout(r, BLOCK_FIRE_DELAY_MS));
        }

        const walletsNeeded = Math.min(
          WALLETS_PER_BLOCK,
          fundedWallets.length,
          TOTAL_TARGET > 0
            ? Math.ceil((TOTAL_TARGET - totalMinted) / MINT_QTY_PER_WALLET)
            : WALLETS_PER_BLOCK
        );

        console.log(`🔨 Block #${blockNumber} — Firing ${walletsNeeded} wallets × ${MINT_QTY_PER_WALLET} = ${walletsNeeded * MINT_QTY_PER_WALLET} NFTs`);

        const result = await mintInBlock(
          fundedWallets.slice(0, walletsNeeded),
          mintRoute,
          provider,
          blockNumber,
        );

        allResults.push(result);
        totalMinted += result.succeeded * MINT_QTY_PER_WALLET;
        blocksUsed++;

        console.log(`   ✅ ${result.succeeded}/${result.attempted} txs broadcast`);
        if (result.txHashes.length > 0) {
          console.log(`   📝 ${result.txHashes.slice(0, 3).map(h => h.slice(0, 16) + '...').join(', ')}${result.txHashes.length > 3 ? ` +${result.txHashes.length - 3} more` : ''}`);
        }
        if (result.errors.length > 0) {
          console.log(`   ❌ ${result.errors.slice(0, 2).join(' | ')}`);
        }
        console.log(`   📊 Total: ${totalMinted} minted across ${blocksUsed} blocks\n`);

        if ((TOTAL_TARGET > 0 && totalMinted >= TOTAL_TARGET) || blocksUsed >= MAX_BLOCKS) {
          finish();
          return;
        }
      } catch (err: any) {
        console.error(`   ⚠️ Block ${blockNumber} error: ${err.message}`);
      }

      processing = false;

      if (INTER_BLOCK_COOLDOWN_MS > 0) {
        await new Promise(r => setTimeout(r, INTER_BLOCK_COOLDOWN_MS));
      }
    };

    const finish = () => {
      blockProvider.removeAllListeners('block');
      printFinalReport(allResults, totalMinted, blocksUsed);
      resolve();
    };

    blockProvider.on('block', onBlock);

    // Safety timeout
    const maxRuntime = MAX_BLOCKS * 15_000;
    setTimeout(() => {
      blockProvider.removeAllListeners('block');
      console.log('\n⏰ Max runtime reached. Stopping.');
      printFinalReport(allResults, totalMinted, blocksUsed);
      resolve();
    }, maxRuntime);
  });
}

function printFinalReport(results: BlockMintResult[], totalMinted: number, blocksUsed: number) {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  FINAL REPORT');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Total Minted:    ~${totalMinted} NFTs`);
  console.log(`  Blocks Used:     ${blocksUsed}`);
  console.log(`  Success Rate:    ${results.reduce((a, r) => a + r.succeeded, 0)}/${results.reduce((a, r) => a + r.attempted, 0)} txs`);

  const allHashes = results.flatMap(r => r.txHashes);
  if (allHashes.length > 0) {
    console.log(`  TX Hashes:`);
    for (const h of allHashes) {
      console.log(`    ${h}`);
    }
  }

  const allErrors = results.flatMap(r => r.errors);
  if (allErrors.length > 0) {
    console.log(`  Errors:`);
    for (const e of allErrors.slice(0, 10)) {
      console.log(`    ${e}`);
    }
  }

  console.log('═══════════════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('💀 Fatal error:', err.message);
  process.exit(1);
});

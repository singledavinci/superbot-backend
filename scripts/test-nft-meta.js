#!/usr/bin/env node
/**
 * Manual smoke test for NFTMetadataClient + WalletProfileClient.
 *
 * Hits the real OpenSea + Alchemy APIs, so set OPENSEA_API_KEY and
 * ALCHEMY_API_KEY in your environment before running.
 *
 * Usage:
 *   node scripts/test-nft-meta.js
 *   node scripts/test-nft-meta.js --contract 0x...... --token 1234
 *   node scripts/test-nft-meta.js --wallet 0xd8da6...
 */

require('dotenv').config();

// Compile-on-the-fly so we don't need a prior `npm run build` for this script.
require('ts-node').register({
    transpileOnly: true,
    compilerOptions: { module: 'CommonJS' },
});

const { NFTMetadataClient, WalletProfileClient } = require('../packages/analytics/src');

function arg(name, defaultValue) {
    const idx = process.argv.indexOf(`--${name}`);
    if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
    return defaultValue;
}

(async () => {
    const contract = arg('contract', '0xed5af388653567af2f388e6224dc7c4b3241c544'); // azuki
    const tokenId = arg('token', '1234');
    const wallet = arg('wallet', '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'); // vitalik.eth

    if (!process.env.OPENSEA_API_KEY) {
        console.warn('⚠️  OPENSEA_API_KEY not set — OpenSea calls will be skipped.');
    }
    if (!process.env.ALCHEMY_API_KEY) {
        console.warn('⚠️  ALCHEMY_API_KEY not set — ENS / Alchemy fallbacks will be skipped.');
    }

    const nfts = new NFTMetadataClient();
    const wallets = new WalletProfileClient();

    console.log(`\n=== NFTMetadataClient.fetchNFT('ethereum', ${contract}, ${tokenId}) ===`);
    const t0 = Date.now();
    const nft = await nfts.fetchNFT('ethereum', contract, tokenId);
    console.log(`(${Date.now() - t0}ms)`);
    console.log(JSON.stringify(nft, null, 2));

    console.log(`\n=== NFTMetadataClient.fetchCollection(${contract}) ===`);
    const t1 = Date.now();
    const col = await nfts.fetchCollection(contract);
    console.log(`(${Date.now() - t1}ms)`);
    console.log(JSON.stringify(col, null, 2));

    console.log(`\n=== WalletProfileClient.fetchProfile(${wallet}) ===`);
    const t2 = Date.now();
    const profile = await wallets.fetchProfile(wallet);
    console.log(`(${Date.now() - t2}ms)`);
    console.log(JSON.stringify(profile, null, 2));

    if (wallet.toLowerCase() === '0xd8da6bf26964af9d7eed9e03e53415d37aa96045') {
        if (profile.ens === 'vitalik.eth') {
            console.log('\n✓ ENS reverse lookup OK (vitalik.eth)');
        } else {
            console.log(`\n✗ Expected vitalik.eth, got ${profile.ens}`);
        }
    }

    process.exit(0);
})().catch(err => {
    console.error('smoke test failed:', err);
    process.exit(1);
});

#!/usr/bin/env node
/**
 * Render a textual approximation of what an enriched whale-buy embed will
 * look like in Discord. Pulls real data from OpenSea + Alchemy.
 *
 * Usage:
 *   node scripts/preview-embed.js
 *   node scripts/preview-embed.js --contract 0x... --token 1234 --wallet 0x...
 */

require('dotenv').config();
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS' } });

const { NFTMetadataClient, WalletProfileClient } = require('../packages/analytics/src');
const { createWhaleBuyEmbed } = require('../apps/bot/src/embeds');

function arg(name, fallback) {
    const idx = process.argv.indexOf(`--${name}`);
    return idx >= 0 ? process.argv[idx + 1] : fallback;
}

(async () => {
    const contract = arg('contract', '0xed5af388653567af2f388e6224dc7c4b3241c544');
    const tokenId = arg('token', '1234');
    const wallet = arg('wallet', '0xd8da6bf26964af9d7eed9e03e53415d37aa96045');

    const nfts = new NFTMetadataClient();
    const wallets = new WalletProfileClient();

    const t0 = Date.now();
    const [nftMeta, walletProfile] = await Promise.all([
        nfts.fetchNFT('ethereum', contract, tokenId),
        wallets.fetchProfile(wallet),
    ]);
    const totalMs = Date.now() - t0;

    const embed = createWhaleBuyEmbed({
        contract,
        wallet,
        tokenId,
        txHash: '0x' + 'a'.repeat(64),
        alertType: 'WHALE_BUY',
        price: '4.2',
        currency: 'ETH',
        marketplace: 'OpenSea',
        label: null,
        intelligence: {
            grade: 'Strong Bullish',
            context: 'Whale with proven track record entered position.',
            risk: null,
            nextWatch: 'monitor for additional accumulation',
        },
        nftMeta,
        walletProfile,
        counterpartyProfile: null,
    });

    const json = embed.toJSON();
    console.log('=== Embed preview ===');
    console.log(`Total enrichment latency: ${totalMs}ms`);
    console.log();
    console.log('Title:        ', json.title);
    console.log('Author:       ', json.author?.name, json.author?.url ? `<${json.author.url}>` : '');
    console.log('Description:  ', json.description);
    console.log('Thumbnail:    ', json.thumbnail?.url || '(none)');
    console.log('Color:        ', json.color);
    console.log('Fields:');
    for (const f of json.fields || []) {
        console.log(`  • ${f.name}${f.inline ? ' (inline)' : ''}`);
        console.log(`      ${f.value.replace(/\n/g, '\n      ')}`);
    }
    console.log('Footer:       ', json.footer?.text);
    process.exit(0);
})().catch(err => {
    console.error('preview failed:', err);
    process.exit(1);
});

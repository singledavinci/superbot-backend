#!/usr/bin/env node
/**
 * Render a textual approximation of what an enriched whale-buy embed will
 * look like in Discord. Pulls real data from OpenSea + Alchemy.
 *
 * Usage:
 *   node scripts/preview-embed.js
 *   node scripts/preview-embed.js --mass-listing-only
 *   node scripts/preview-embed.js --contract 0x... --token 1234 --wallet 0x...
 */

require('dotenv').config();
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS' } });

const { NFTMetadataClient, WalletProfileClient } = require('../packages/analytics/src');
const { createWhaleBuyEmbed, createMassListingEmbed } = require('../apps/bot/src/embeds');

function arg(name, fallback) {
    const idx = process.argv.indexOf(`--${name}`);
    return idx >= 0 ? process.argv[idx + 1] : fallback;
}

(async () => {
    const massOnly = process.argv.includes('--mass-listing-only');
    const contract = arg('contract', '0xed5af388653567af2f388e6224dc7c4b3241c544');
    const tokenId = arg('token', '1234');
    const wallet = arg('wallet', '0xd8da6bf26964af9d7eed9e03e53415d37aa96045');

    const nfts = new NFTMetadataClient();
    const wallets = new WalletProfileClient();

    async function previewMassListing() {
        const colMeta = await nfts.fetchCollection(contract).catch(() => null);
        const noSlug = createMassListingEmbed({
            collectionName: 'Example collection',
            contract,
            chain: 'ethereum',
            listingCount: 11,
            windowMs: 300000,
            collectionMeta: null,
        })
            .toJSON()
            .fields?.find((f) => f.name === 'Links')?.value;
        const withEnrich = createMassListingEmbed({
            collectionName: colMeta?.name ?? 'Example collection',
            contract,
            chain: 'ethereum',
            listingCount: 11,
            windowMs: 300000,
            collectionMeta: colMeta,
        })
            .toJSON()
            .fields?.find((f) => f.name === 'Links')?.value;
        console.log('=== Mass listing Links row (slug missing → contract OpenSea fallback) ===');
        console.log(noSlug);
        console.log();
        console.log('=== Mass listing Links row (after fetchCollection enrichment) ===');
        console.log(withEnrich ?? '(missing)');
        process.exit(0);
    }

    if (massOnly) {
        await previewMassListing();
    }

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

    const massLinksNoSlug =
        createMassListingEmbed({
            collectionName: 'Example collection',
            contract,
            chain: 'ethereum',
            listingCount: 11,
            windowMs: 300000,
            collectionMeta: null,
        })
            .toJSON()
            .fields?.find((f) => f.name === 'Links')?.value ?? '';
    console.log();
    console.log('=== Mass listing Links row (slug omitted — contract OpenSea URL) ===');
    console.log(massLinksNoSlug);

    process.exit(0);
})().catch(err => {
    console.error('preview failed:', err);
    process.exit(1);
});

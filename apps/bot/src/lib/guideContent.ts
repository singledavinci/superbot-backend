import { EmbedBuilder } from 'discord.js';
import { BRAND_ACCENT } from './embedTheme';

export type GuidePage = { title: string; description: string; fields?: { name: string; value: string; inline?: boolean }[] };

export const GUIDE_PAGES: GuidePage[] = [
    {
        title: 'SuperBot — Quick start',
        description:
            'SuperBot watches on-chain NFT activity for this server and posts rich alerts to **SuperBot Alerts** channels. Members opt into pings in `#alert-roles`.',
        fields: [
            {
                name: '1. Connect the bot',
                value: 'Run `/setup` (or ask your operator to run the Railway provisioning scripts for the full channel layout).',
                inline: false,
            },
            {
                name: '2. Track what you care about',
                value:
                    '• `/track-collection` + contract address → interactive menu (auto-detects name)\n' +
                    '• `/track-wallet` + `0x…` → confirm in one click\n' +
                    '• `/untrack-collection` / `/untrack-wallet` to remove',
                inline: false,
            },
            {
                name: '3. Verify routing',
                value: 'Run `/alert-routes` to see which channel and ping role each alert type uses.',
                inline: false,
            },
        ],
    },
    {
        title: 'Tracking collections',
        description:
            'Paste a contract with `/track-collection contract:0x…`. SuperBot resolves the collection name and image, then shows a **setup menu**.',
        fields: [
            {
                name: 'Floor alerts',
                value:
                    'Use the **Floor drop %** and **Floor rise %** dropdowns (e.g. 10 = alert when floor moves ≥10%). Pick **Off** to disable that direction. **Custom %** opens a form for exact values.',
                inline: false,
            },
            {
                name: 'Market surges',
                value:
                    'Tap **Hot mint: On/Off** and **Delist: On/Off** buttons to toggle those alert types. Listing/sweep thresholds use guild defaults unless you use `/floor-alert`.',
                inline: false,
            },
            {
                name: 'Where alerts go',
                value:
                    'Specialized alerts (sweeps, listings, floor, clusters) use **guild routes** from `/alert-routes` — not per-collection channel overrides.',
                inline: false,
            },
            {
                name: 'Custom %',
                value: 'Use **Custom thresholds** to type exact floor drop/rise percentages in a form.',
                inline: false,
            },
        ],
    },
    {
        title: 'Tracking wallets',
        description:
            'Whale alerts fire when a tracked wallet buys, sells, or mints. Batched activity is coalesced into **wallet batch** alerts.',
        fields: [
            {
                name: 'Simple flow',
                value:
                    '`/track-wallet address:0x…` → review the wallet card → **Start tracking** (optional label via **Add label**).',
                inline: false,
            },
            {
                name: 'Channels',
                value: 'Defaults to `#whale-trades` from your alert routes. Per-wallet channel overrides are optional (advanced).',
                inline: false,
            },
            {
                name: 'From an alert',
                value: 'Use **Mute** or **View Wallet Stats** buttons on whale embeds (stats coming soon).',
                inline: false,
            },
        ],
    },
    {
        title: 'Alert types & channels',
        description: 'Each signal has a home under **SuperBot Alerts**:',
        fields: [
            { name: '📈 Mint radar', value: 'High mint velocity on **tracked** collections', inline: true },
            { name: '🔥 Hot mints', value: 'Aggressive minting clusters', inline: true },
            { name: '🐋 Whale trades', value: 'Tracked wallet buy / sale / mint', inline: true },
            { name: '🧮 Wallet batches', value: 'Many actions by one wallet in ~90s', inline: true },
            { name: '🧠 Cluster buys', value: 'Multiple smart wallets same collection', inline: true },
            { name: '💰 Sweeps', value: 'Large floor sweeps', inline: true },
            { name: '📊 Listing activity', value: 'Mass listings / delists + floor follow-up', inline: true },
            { name: '📉 Floor alerts', value: 'Floor drop / rise vs your % thresholds', inline: true },
            { name: '📡 Opportunities', value: 'Momentum score spikes', inline: true },
        ],
    },
    {
        title: 'Commands cheat sheet',
        description: 'Admin / power-user commands:',
        fields: [
            {
                name: 'Setup & routing',
                value: '`/setup` · `/alert-routes` · `/status` · `/refresh-commands`',
                inline: false,
            },
            {
                name: 'Tracking',
                value:
                    '`/track-collection` · `/track-wallet` · `/untrack-collection` · `/untrack-wallet` · `/watchlist`',
                inline: false,
            },
            {
                name: 'Research',
                value: '`/collection` · `/wallet` · `/trending` · `/smart-money` · `/opportunities` · `/recap`',
                inline: false,
            },
            {
                name: 'Tuning',
                value: '`/floor-alert` · `/opportunity-settings` · `/risk`',
                inline: false,
            },
            {
                name: 'This guide',
                value: '`/guide` — browse pages with **Previous** / **Next**.',
                inline: false,
            },
        ],
    },
];

export function buildGuideEmbed(pageIndex: number): EmbedBuilder {
    const page = GUIDE_PAGES[pageIndex] ?? GUIDE_PAGES[0];
    const embed = new EmbedBuilder()
        .setColor(BRAND_ACCENT)
        .setTitle(page.title)
        .setDescription(page.description)
        .setFooter({
            text: `SuperBot guide · Page ${pageIndex + 1} / ${GUIDE_PAGES.length} · Not financial advice`,
        })
        .setTimestamp();
    if (page.fields?.length) embed.addFields(page.fields);
    return embed;
}

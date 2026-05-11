// Creates a Discord category + alert channels in the user's primary guild, then
// upserts AlertChannel routing rows pointing each alertType at the right channel.
// Also nukes the BLM tracked collection (and any related rows) as a side action.
//
// Required env (provided by `railway run -s Postgres`):
//   DATABASE_URL or DATABASE_PUBLIC_URL  -- Postgres connection
//   DISCORD_TOKEN                        -- bot token (Bearer "Bot <token>")
//   PRIMARY_GUILD_DISCORD_ID             -- snowflake of the Discord server
//
// Idempotent: re-running won't create duplicate channels if names already exist
// (matches by channel name within the target category).

const { Client } = require('pg');

const DISCORD_API = 'https://discord.com/api/v10';
const CATEGORY_NAME = 'SuperBot Alerts';
const BLM_CONTRACT = '0xfa52a2850b822747e3f49ea781c6a45a2aaa4c0b';

const PLAN = [
    { channel: '📈-mint-radar', types: ['MINT_RADAR'], topic: 'Tracked-collection mint events.' },
    { channel: '🔥-hot-mints', types: ['HOT_MINT'], topic: 'Aggressively-minting collections (trending) detected on-chain.' },
    { channel: '🐋-whale-trades', types: ['WHALE_BUY', 'WHALE_SALE'], topic: 'Tracked whale wallets buying / selling.' },
    { channel: '🧮-wallet-batches', types: ['WALLET_ACTION_BATCH'], topic: 'Coalesced batches when a whale acts on many items in a short window.' },
    { channel: '🧠-cluster-buys', types: ['CLUSTER_BUY'], topic: 'Multiple smart-money wallets buying the same collection in a tight window.' },
    { channel: '💰-sweeps', types: ['SWEEP'], topic: 'Large sweep buys on tracked collections.' },
    { channel: '📊-listing-activity', types: ['MASS_LISTING', 'MASS_DELIST', 'FLOOR_IMPACT_FOLLOWUP'], topic: 'Mass listings & mass delistings on tracked collections (with floor-impact follow-ups).' },
    { channel: '📉-floor-alerts', types: ['FLOOR_DROP', 'FLOOR_RISE'], topic: 'Floor price drops & rises on tracked collections.' },
];

async function discord(method, path, token, body) {
    const url = `${DISCORD_API}${path}`;
    const res = await fetch(url, {
        method,
        headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'SuperBot-AlertSetup/1.0',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Discord ${method} ${path} -> ${res.status}: ${text}`);
    }
    return text ? JSON.parse(text) : null;
}

async function listGuildChannels(guildId, token) {
    return discord('GET', `/guilds/${guildId}/channels`, token);
}

async function createChannel(guildId, token, payload) {
    return discord('POST', `/guilds/${guildId}/channels`, token, payload);
}

async function ensureCategory(guildId, token, channels) {
    const existing = channels.find((c) => c.type === 4 && c.name === CATEGORY_NAME);
    if (existing) {
        console.log(`✓ Category "${CATEGORY_NAME}" already exists (id=${existing.id})`);
        return existing.id;
    }
    const created = await createChannel(guildId, token, { name: CATEGORY_NAME, type: 4 });
    console.log(`+ Created category "${CATEGORY_NAME}" (id=${created.id})`);
    return created.id;
}

async function ensureTextChannel(guildId, token, categoryId, channels, name, topic) {
    const existing = channels.find(
        (c) => c.type === 0 && c.name === name && c.parent_id === categoryId,
    );
    if (existing) {
        console.log(`  ✓ #${name} already exists (id=${existing.id})`);
        return existing.id;
    }
    const created = await createChannel(guildId, token, {
        name,
        type: 0,
        parent_id: categoryId,
        topic,
    });
    console.log(`  + Created #${name} (id=${created.id})`);
    return created.id;
}

async function main() {
    const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    const token = process.env.DISCORD_TOKEN;
    const guildDiscordId = process.env.PRIMARY_GUILD_DISCORD_ID || '1417836009202385009';
    if (!dbUrl) throw new Error('Missing DATABASE_PUBLIC_URL / DATABASE_URL');
    if (!token) throw new Error('Missing DISCORD_TOKEN');

    const db = new Client({ connectionString: dbUrl });
    await db.connect();

    // 1. Resolve internal Guild row
    const guildRows = await db.query(
        'SELECT id, "discordId", name FROM "Guild" WHERE "discordId" = $1 LIMIT 1',
        [guildDiscordId],
    );
    if (guildRows.rows.length === 0) {
        throw new Error(`No internal Guild row for discordId ${guildDiscordId}`);
    }
    const internalGuildId = guildRows.rows[0].id;
    console.log(`Guild: "${guildRows.rows[0].name}" (discord=${guildDiscordId}, internal=${internalGuildId})`);

    // 2. Discover existing channels (idempotency)
    const channels = await listGuildChannels(guildDiscordId, token);
    console.log(`Found ${channels.length} existing channels in this guild.`);

    // 3. Ensure category
    const categoryId = await ensureCategory(guildDiscordId, token, channels);

    // 4. Ensure each text channel + collect typeToChannelId mapping
    const typeToChannelId = {};
    for (const { channel, types, topic } of PLAN) {
        const channelId = await ensureTextChannel(guildDiscordId, token, categoryId, channels, channel, topic);
        for (const t of types) typeToChannelId[t] = channelId;
    }

    // 5. Upsert AlertChannel rows (route alertType -> channel)
    console.log('\nUpserting AlertChannel routing rows...');
    for (const [alertType, discordChannelId] of Object.entries(typeToChannelId)) {
        await db.query(
            `INSERT INTO "AlertChannel" ("id", "guildId", "discordChannelId", "name", "alertType", "createdAt", "updatedAt")
             VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW(), NOW())
             ON CONFLICT ("guildId", "alertType")
             DO UPDATE SET "discordChannelId" = EXCLUDED."discordChannelId",
                           "name" = EXCLUDED."name",
                           "updatedAt" = NOW()`,
            [internalGuildId, discordChannelId, alertType.toLowerCase().replace(/_/g, '-'), alertType],
        );
        console.log(`  routed ${alertType.padEnd(28)} -> ${discordChannelId}`);
    }

    // 6. Remove BLM tracked collection (and cascade-delete any per-collection state)
    console.log('\nRemoving BLM tracked collection...');
    const delBlm = await db.query(
        `DELETE FROM "TrackedCollection" WHERE LOWER("contractAddress") = LOWER($1) RETURNING id, name`,
        [BLM_CONTRACT],
    );
    if (delBlm.rows.length > 0) {
        for (const r of delBlm.rows) console.log(`  - deleted TrackedCollection ${r.name} (id=${r.id})`);
    } else {
        console.log('  (none found — already removed)');
    }

    // 7. Summary
    console.log('\nSUMMARY');
    console.log(`  category id            ${categoryId}`);
    console.log(`  channels created/kept  ${PLAN.length}`);
    console.log(`  routing rows upserted  ${Object.keys(typeToChannelId).length}`);
    console.log(`  BLM collection rows    ${delBlm.rows.length} deleted`);

    await db.end();
}

main().catch((err) => {
    console.error('\nFAILED:', err.message);
    process.exit(1);
});

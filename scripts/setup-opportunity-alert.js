// Idempotent: ensures #📡-opportunities under "SuperBot Alerts", role "Collection Opportunities",
// and AlertChannel row for OPPORTUNITY_SPIKE in the primary guild.
//
// Env: DATABASE_PUBLIC_URL|DATABASE_URL, DISCORD_TOKEN, PRIMARY_GUILD_DISCORD_ID (optional)

const { Client } = require('pg');

const DISCORD_API = 'https://discord.com/api/v10';
const CATEGORY_NAME = 'SuperBot Alerts';
const CHANNEL_NAME = '📡-opportunities';
const ROLE_NAME = 'Collection Opportunities';

async function discord(method, path, token, body) {
    const url = `${DISCORD_API}${path}`;
    const res = await fetch(url, {
        method,
        headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'SuperBot-OpportunitySetup/1.0',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Discord ${method} ${path} -> ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
}

async function listGuildChannels(guildId, token) {
    return discord('GET', `/guilds/${guildId}/channels`, token);
}

async function createChannel(guildId, token, payload) {
    return discord('POST', `/guilds/${guildId}/channels`, token, payload);
}

async function listRoles(guildId, token) {
    return discord('GET', `/guilds/${guildId}/roles`, token);
}

async function createRole(guildId, token, payload) {
    return discord('POST', `/guilds/${guildId}/roles`, token, payload);
}

async function main() {
    const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    const token = process.env.DISCORD_TOKEN;
    const guildDiscordId = process.env.PRIMARY_GUILD_DISCORD_ID || '1417836009202385009';
    if (!dbUrl) throw new Error('Missing DATABASE_PUBLIC_URL / DATABASE_URL');
    if (!token) throw new Error('Missing DISCORD_TOKEN');

    const db = new Client({ connectionString: dbUrl });
    await db.connect();

    const guildRows = await db.query(
        'SELECT id, "discordId", name FROM "Guild" WHERE "discordId" = $1 LIMIT 1',
        [guildDiscordId],
    );
    if (guildRows.rows.length === 0) throw new Error(`No Guild row for discordId ${guildDiscordId}`);
    const internalGuildId = guildRows.rows[0].id;
    console.log(`Guild: ${guildRows.rows[0].name} (${guildDiscordId}) internal=${internalGuildId}`);

    const channels = await listGuildChannels(guildDiscordId, token);
    const category = channels.find((c) => c.type === 4 && c.name === CATEGORY_NAME);
    if (!category) throw new Error(`Category "${CATEGORY_NAME}" not found — run scripts/setup-alert-channels.js first.`);
    const categoryId = category.id;

    let ch = channels.find((c) => c.type === 0 && c.name === CHANNEL_NAME && c.parent_id === categoryId);
    if (!ch) {
        ch = await createChannel(guildDiscordId, token, {
            name: CHANNEL_NAME,
            type: 0,
            parent_id: categoryId,
            topic: 'Informational collection momentum signals (not financial advice).',
        });
        console.log(`+ Created #${CHANNEL_NAME} id=${ch.id}`);
    } else {
        console.log(`✓ Channel #${CHANNEL_NAME} exists id=${ch.id}`);
    }

    const roles = await listRoles(guildDiscordId, token);
    let role = roles.find((r) => r.name === ROLE_NAME);
    if (!role) {
        role = await createRole(guildDiscordId, token, {
            name: ROLE_NAME,
            mentionable: true,
        });
        console.log(`+ Created role "${ROLE_NAME}" id=${role.id}`);
    } else {
        console.log(`✓ Role "${ROLE_NAME}" exists id=${role.id}`);
    }

    await db.query(
        `INSERT INTO "AlertChannel" ("id", "guildId", "discordChannelId", "name", "alertType", "mentionRoleId", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, $3, 'OPPORTUNITY_SPIKE', $4, NOW(), NOW())
         ON CONFLICT ("guildId", "alertType")
         DO UPDATE SET "discordChannelId" = EXCLUDED."discordChannelId",
                       "mentionRoleId" = EXCLUDED."mentionRoleId",
                       "name" = EXCLUDED."name",
                       "updatedAt" = NOW()`,
        [internalGuildId, ch.id, 'opportunity-spike', role.id],
    );
    console.log(`Upserted OPPORTUNITY_SPIKE -> channel ${ch.id} role ${role.id}`);

    await db.end();
    console.log('Done.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

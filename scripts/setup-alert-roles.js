// Creates pingable Discord roles, wires AlertChannel.mentionRoleId, ensures #alert-roles,
// and posts (or updates) the self-serve role-picker message.
//
// Env (via `railway run -s Postgres` or local .env):
//   DATABASE_PUBLIC_URL | DATABASE_URL
//   DISCORD_TOKEN
//   PRIMARY_GUILD_DISCORD_ID  (default: Super dads production guild)
//
// Idempotent: existing roles/channels/messages are reused; DB only updates mentionRoleId.

const { Client } = require('pg');

const DISCORD_API = 'https://discord.com/api/v10';
const GUILD_DISCORD_ID = process.env.PRIMARY_GUILD_DISCORD_ID || '1417836009202385009';
const CATEGORY_NAME = 'SuperBot Alerts';
const PICKER_CHANNEL_NAME = 'alert-roles';
const PICKER_SENTINEL = '[superbot-role-picker:v1]';

/** Role display name -> Discord role payload + which AlertChannel.alertType rows use it */
const ROLE_PLAN = [
    {
        name: 'Mint Radar',
        color: 15105570,
        emoji: '📈',
        alertTypes: ['MINT_RADAR'],
        buttonStyle: 1,
    },
    {
        name: 'Hot Mints',
        color: 16738005,
        emoji: '🔥',
        alertTypes: ['HOT_MINT'],
        buttonStyle: 1,
    },
    {
        name: 'Whale Trades',
        color: 10181046,
        emoji: '🐋',
        alertTypes: ['WHALE_BUY', 'WHALE_SALE'],
        buttonStyle: 2,
    },
    {
        name: 'Wallet Batches',
        color: 1752220,
        emoji: '🧮',
        alertTypes: ['WALLET_ACTION_BATCH'],
        buttonStyle: 2,
    },
    {
        name: 'Cluster Buys',
        color: 9320925,
        emoji: '🧠',
        alertTypes: ['CLUSTER_BUY'],
        buttonStyle: 1,
    },
    {
        name: 'Sweeps',
        color: 15844367,
        emoji: '💰',
        alertTypes: ['SWEEP'],
        buttonStyle: 1,
    },
    {
        name: 'Listing Activity',
        color: 3447003,
        emoji: '📊',
        alertTypes: ['MASS_LISTING', 'MASS_DELIST', 'FLOOR_IMPACT_FOLLOWUP'],
        buttonStyle: 2,
    },
    {
        name: 'Floor Alerts',
        color: 52945,
        emoji: '📉',
        alertTypes: ['FLOOR_DROP', 'FLOOR_RISE'],
        buttonStyle: 2,
    },
];

async function discord(method, path, token, body) {
    const url = `${DISCORD_API}${path}`;
    const res = await fetch(url, {
        method,
        headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'SuperBot-AlertRoles/1.0',
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
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

async function listGuildRoles(guildId, token) {
    return discord('GET', `/guilds/${guildId}/roles`, token);
}

async function createRole(guildId, token, payload) {
    return discord('POST', `/guilds/${guildId}/roles`, token, payload);
}

async function createGuildChannel(guildId, token, payload) {
    return discord('POST', `/guilds/${guildId}/channels`, token, payload);
}

async function listChannelMessages(channelId, token, limit = 50) {
    return discord('GET', `/channels/${channelId}/messages?limit=${limit}`, token);
}

async function createMessage(channelId, token, body) {
    return discord('POST', `/channels/${channelId}/messages`, token, body);
}

async function patchMessage(channelId, messageId, token, body) {
    return discord('PATCH', `/channels/${channelId}/messages/${messageId}`, token, body);
}

function buildPickerComponents(rolePlan, roleIdByName) {
    const buttons = rolePlan.map((r) => {
        const rid = roleIdByName.get(r.name);
        if (!rid) throw new Error(`Missing role id for ${r.name}`);
        return {
            type: 2,
            style: r.buttonStyle,
            label: r.name,
            emoji: { name: r.emoji },
            custom_id: `togglerole:${rid}`,
        };
    });
    const rows = [];
    for (let i = 0; i < buttons.length; i += 4) {
        rows.push({ type: 1, components: buttons.slice(i, i + 4) });
    }
    return rows;
}

function buildPickerPayload(rolePlan, roleIdByName) {
    const categoryGuide = rolePlan
        .map((r) => `${r.emoji} **${r.name}** — ${r.alertTypes.join(', ').replace(/_/g, ' ').toLowerCase()}`)
        .join('\n');

    return {
        embeds: [
            {
                title: '🔔 SuperBot alert subscriptions',
                description:
                    'Pick the signals you care about. Each button **toggles** a ping role on your account — press again anytime to unsubscribe.\n\n' +
                    '**How it works**\n' +
                    '• Alerts post in dedicated channels under **SuperBot Alerts**\n' +
                    '• You are pinged **only** for categories you enable below\n' +
                    '• Admins can audit routing anytime with `/alert-routes`\n\n' +
                    '**Categories**\n' +
                    categoryGuide,
                color: 0x5865f2,
                footer: { text: `SuperBot · Not financial advice · ${PICKER_SENTINEL}` },
            },
        ],
        components: buildPickerComponents(rolePlan, roleIdByName),
    };
}

async function main() {
    const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    const token = process.env.DISCORD_TOKEN;
    if (!dbUrl) throw new Error('Missing DATABASE_PUBLIC_URL / DATABASE_URL');
    if (!token) throw new Error('Missing DISCORD_TOKEN');

    const db = new Client({ connectionString: dbUrl });
    await db.connect();

    const guildRows = await db.query(
        'SELECT id, "discordId", name FROM "Guild" WHERE "discordId" = $1 LIMIT 1',
        [GUILD_DISCORD_ID],
    );
    if (guildRows.rows.length === 0) {
        throw new Error(`No internal Guild row for discordId ${GUILD_DISCORD_ID}`);
    }
    const internalGuildId = guildRows.rows[0].id;
    console.log(`Guild: "${guildRows.rows[0].name}" (discord=${GUILD_DISCORD_ID}, internal=${internalGuildId})`);

    const channels = await listGuildChannels(GUILD_DISCORD_ID, token);
    const mintRadar = channels.find((c) => c.type === 0 && c.name === '📈-mint-radar');
    if (!mintRadar?.parent_id) {
        throw new Error('Could not find #📈-mint-radar or it has no parent category');
    }
    const categoryId = mintRadar.parent_id;
    const cat = channels.find((c) => c.id === categoryId);
    console.log(`Category: "${cat?.name || CATEGORY_NAME}" (id=${categoryId})`);

    let pickerChannel = channels.find((c) => c.type === 0 && c.name === PICKER_CHANNEL_NAME);
    if (pickerChannel) {
        console.log(`✓ #${PICKER_CHANNEL_NAME} already exists (id=${pickerChannel.id})`);
    } else {
        pickerChannel = await createGuildChannel(GUILD_DISCORD_ID, token, {
            name: PICKER_CHANNEL_NAME,
            type: 0,
            parent_id: categoryId,
            topic:
                'Pick the alert categories you want pings for. Click a button to add or remove its role.',
        });
        console.log(`+ Created #${PICKER_CHANNEL_NAME} (id=${pickerChannel.id})`);
    }

    const roles = await listGuildRoles(GUILD_DISCORD_ID, token);
    const roleIdByName = new Map();

    for (const spec of ROLE_PLAN) {
        const existing = roles.find((r) => r.name === spec.name);
        if (existing) {
            console.log(`✓ Role "${spec.name}" exists (id=${existing.id})`);
            roleIdByName.set(spec.name, existing.id);
            continue;
        }
        const created = await createRole(GUILD_DISCORD_ID, token, {
            name: spec.name,
            color: spec.color,
            hoist: false,
            mentionable: true,
            permissions: '0',
        });
        console.log(`+ Created role "${spec.name}" (id=${created.id})`);
        roleIdByName.set(spec.name, created.id);
        roles.push(created);
    }

    console.log('\nUpdating AlertChannel.mentionRoleId (only this column)...');
    let updated = 0;
    for (const spec of ROLE_PLAN) {
        const rid = roleIdByName.get(spec.name);
        for (const alertType of spec.alertTypes) {
            const r = await db.query(
                `UPDATE "AlertChannel"
                 SET "mentionRoleId" = $1, "updatedAt" = NOW()
                 WHERE "guildId" = $2 AND "alertType" = $3
                 RETURNING "alertType"`,
                [rid, internalGuildId, alertType],
            );
            if (r.rows.length === 0) {
                console.warn(`  (no row for alertType=${alertType} — skipped)`);
            } else {
                console.log(`  ${alertType} -> role ${rid}`);
                updated += r.rows.length;
            }
        }
    }

    const pickerBody = buildPickerPayload(ROLE_PLAN, roleIdByName);
    let pickerMessageId = null;
    try {
        const recent = await listChannelMessages(pickerChannel.id, token, 50);
        const found = recent.find(
            (m) =>
                m.embeds &&
                m.embeds.some(
                    (e) =>
                        (e.footer && String(e.footer.text || '').includes(PICKER_SENTINEL)) ||
                        (e.description && String(e.description).includes(PICKER_SENTINEL)),
                ),
        );
        if (found) {
            await patchMessage(pickerChannel.id, found.id, token, pickerBody);
            pickerMessageId = found.id;
            console.log(`\n✓ Updated existing role-picker message (id=${found.id})`);
        } else {
            const posted = await createMessage(pickerChannel.id, token, pickerBody);
            pickerMessageId = posted.id;
            console.log(`\n+ Posted role-picker message (id=${posted.id})`);
        }
    } catch (e) {
        console.error('\nFAILED to post/update picker message:', e.message);
        throw e;
    }

    console.log('\nSUMMARY');
    console.log(`  internal guild id     ${internalGuildId}`);
    console.log(`  #alert-roles id       ${pickerChannel.id}`);
    console.log(`  picker message id     ${pickerMessageId}`);
    console.log(`  AlertChannel rows touched (updates)  ${updated}`);
    for (const spec of ROLE_PLAN) {
        console.log(`  role ${spec.name.padEnd(18)} ${roleIdByName.get(spec.name)}`);
    }

    await db.end();
}

main().catch((err) => {
    console.error('\nFAILED:', err.message);
    process.exit(1);
});

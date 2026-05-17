const { Client } = require('pg');

const DISCORD_API = 'https://discord.com/api/v10';
const CATEGORY_NAME = 'SuperBot Alerts';
const GUILD_ID = process.env.PRIMARY_GUILD_DISCORD_ID || '1417836009202385009';

const DELETE_CHANNEL_IDS = [
    '1503277339558023178',
    '1503273505049804810',
    '1503273506606157938',
    '1503273508770283701',
    '1503273510368317601',
    '1503273511840518224',
    '1503273513627422851',
    '1503273515363598416',
    '1503273517397966879',
    '1503381748497514638',
];

const DB_QUERIES = [
    { table: 'AlertChannel', col: 'discordChannelId' },
    { table: 'TrackedCollection', col: 'alertChannelId' },
    { table: 'TrackedCollection', col: 'hotMintChannelId' },
    { table: 'TrackedCollection', col: 'delistChannelId' },
    { table: 'TrackedWallet', col: 'alertChannelId' },
    { table: 'Guild', col: 'alertChannelId' },
];

async function discord(method, path, token) {
    const res = await fetch(`${DISCORD_API}${path}`, {
        method,
        headers: { Authorization: `Bot ${token}`, 'User-Agent': 'SuperBot-Dedupe/1.0' },
    });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`Discord ${method} ${path} -> ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
}

async function main() {
    const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    const token = process.env.DISCORD_TOKEN;
    if (!dbUrl) throw new Error('Missing DATABASE_URL');
    if (!token) throw new Error('Missing DISCORD_TOKEN');

    const db = new Client({ connectionString: dbUrl });
    await db.connect();

    const routes = await db.query('SELECT "discordChannelId" FROM "AlertChannel"');
    const keepIds = new Set(routes.rows.map(r => r.discordChannelId));
    keepIds.add('1505419448117366796');

    const channels = await discord('GET', `/guilds/${GUILD_ID}/channels`, token);
    const children = channels.filter(c => c.parent_id === channels.find(x => x.type === 4 && x.name === CATEGORY_NAME)?.id && c.type === 0);

    const toDelete = new Set(DELETE_CHANNEL_IDS);
    console.log('Keeping:', [...keepIds].join(', '));
    console.log('Deleting', toDelete.size, 'duplicate channel(s)\n');

    let deleted = 0;
    for (const channelId of toDelete) {
        if (keepIds.has(channelId)) {
            console.log('SKIP canonical', channelId);
            continue;
        }
        for (const { table, col } of DB_QUERIES) {
            try {
                const r = await db.query(`UPDATE "${table}" SET "${col}" = NULL WHERE "${col}" = $1`, [channelId]);
                if (r.rowCount > 0) console.log('  nulled', r.rowCount, table + '.' + col);
            } catch (err) {
                if (err.code !== '42703' && err.code !== '42P01') throw err;
            }
        }
        const ch = children.find(c => c.id === channelId);
        await discord('DELETE', `/channels/${channelId}`, token);
        console.log('DELETED', ch ? '#' + ch.name : channelId, channelId);
        deleted++;
    }
    console.log('\nDeleted', deleted);
    await db.end();
}

main().catch(e => { console.error(e); process.exit(1); });
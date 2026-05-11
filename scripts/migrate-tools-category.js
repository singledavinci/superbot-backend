// Migrates DB rows pointing at channels under the "TOOLS" Discord category,
// repoints them to the equivalent SuperBot Alerts channels, then deletes the
// old channels and the TOOLS category itself.
//
// Required env: DATABASE_PUBLIC_URL/DATABASE_URL, DISCORD_TOKEN, PRIMARY_GUILD_DISCORD_ID

const { Client } = require('pg');

const DISCORD_API = 'https://discord.com/api/v10';
const GUILD_ID = process.env.PRIMARY_GUILD_DISCORD_ID || '1417836009202385009';
const OLD_CATEGORY_NAME = 'TOOLS';
const NEW_CATEGORY_NAME = 'SuperBot Alerts';

async function discord(method, path, token, body) {
    const res = await fetch(`${DISCORD_API}${path}`, {
        method,
        headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'SuperBot-Migrate/1.0',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`Discord ${method} ${path} -> ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
}

function inferTargetChannel(oldName, newChannelsByEmoji) {
    const n = oldName.toLowerCase();
    if (n.includes('bot-command') || n.includes('command')) return null;
    if (n.includes('floor')) return newChannelsByEmoji['📉'];
    if (n.includes('hot') && n.includes('mint')) return newChannelsByEmoji['🔥'];
    if (n.includes('mint')) return newChannelsByEmoji['📈'];
    if (n.includes('wallet')) return newChannelsByEmoji['🐋'];
    if (n.includes('whale')) return newChannelsByEmoji['🐋'];
    if (n.includes('sweep')) return newChannelsByEmoji['💰'];
    if (n.includes('listing') || n.includes('delist')) return newChannelsByEmoji['📊'];
    if (n.includes('cluster')) return newChannelsByEmoji['🧠'];
    if (n.includes('batch')) return newChannelsByEmoji['🧮'];
    return null;
}

(async () => {
    const dbUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
    const token = process.env.DISCORD_TOKEN;
    if (!dbUrl) throw new Error('Missing DATABASE_PUBLIC_URL/DATABASE_URL');
    if (!token) throw new Error('Missing DISCORD_TOKEN');

    const db = new Client({ connectionString: dbUrl });
    await db.connect();

    const channels = await discord('GET', `/guilds/${GUILD_ID}/channels`, token);

    const oldCategory = channels.find(
        (c) => c.type === 4 && c.name.toUpperCase().includes(OLD_CATEGORY_NAME.toUpperCase()),
    );
    const newCategory = channels.find((c) => c.type === 4 && c.name === NEW_CATEGORY_NAME);
    if (!oldCategory) {
        console.log(`No "${OLD_CATEGORY_NAME}" category found — nothing to migrate.`);
        await db.end();
        return;
    }
    if (!newCategory) {
        throw new Error(`"${NEW_CATEGORY_NAME}" category not found — run setup-alert-channels.js first.`);
    }

    const oldChildren = channels.filter((c) => c.parent_id === oldCategory.id && c.type === 0);
    const newChildren = channels.filter((c) => c.parent_id === newCategory.id && c.type === 0);

    // Map new channels by their leading emoji so we can route the old ones cleanly.
    const newByEmoji = {};
    for (const ch of newChildren) {
        const first = Array.from(ch.name)[0];
        if (first) newByEmoji[first] = ch;
    }

    console.log(`Old TOOLS children (${oldChildren.length}):`);
    for (const c of oldChildren) console.log(`  #${c.name} (id=${c.id})`);
    console.log(`New SuperBot Alerts children (${newChildren.length}):`);
    for (const c of newChildren) console.log(`  #${c.name} (id=${c.id})`);

    // For every old child, find DB rows pointing at it and repoint them.
    const DB_QUERIES = [
        { table: 'AlertChannel', col: 'discordChannelId' },
        { table: 'TrackedCollection', col: 'alertChannelId' },
        { table: 'TrackedCollection', col: 'hotMintChannelId' },
        { table: 'TrackedCollection', col: 'mintChannelId' },
        { table: 'TrackedCollection', col: 'salesChannelId' },
        { table: 'TrackedCollection', col: 'floorChannelId' },
        { table: 'TrackedCollection', col: 'listingChannelId' },
        { table: 'TrackedWallet', col: 'alertChannelId' },
        { table: 'Guild', col: 'alertChannelId' },
    ];

    let migratedRows = 0;
    let nulledRows = 0;
    for (const child of oldChildren) {
        const target = inferTargetChannel(child.name, newByEmoji);
        const targetId = target ? target.id : null;
        console.log(`\n#${child.name} (${child.id}) → ${target ? `#${target.name} (${target.id})` : 'NULL (no clean mapping; will null out)'}`);
        for (const { table, col } of DB_QUERIES) {
            try {
                const sql = targetId
                    ? `UPDATE "${table}" SET "${col}" = $1 WHERE "${col}" = $2 RETURNING id`
                    : `UPDATE "${table}" SET "${col}" = NULL WHERE "${col}" = $2 RETURNING id`;
                const params = targetId ? [targetId, child.id] : [child.id];
                const r = await db.query(sql, params);
                if (r.rowCount > 0) {
                    console.log(`  ${table}.${col}: ${r.rowCount} row(s) updated`);
                    if (targetId) migratedRows += r.rowCount;
                    else nulledRows += r.rowCount;
                }
            } catch (err) {
                if (err.code === '42703' || err.code === '42P01') continue;
                console.error(`  ${table}.${col}: ${err.code} ${err.message}`);
            }
        }
    }

    // Now delete every child channel of TOOLS.
    console.log('\nDeleting old TOOLS child channels...');
    for (const child of oldChildren) {
        try {
            await discord('DELETE', `/channels/${child.id}`, token);
            console.log(`  - #${child.name} deleted`);
        } catch (err) {
            console.error(`  ! Failed to delete #${child.name}: ${err.message}`);
        }
    }

    // Finally delete the TOOLS category itself.
    console.log(`\nDeleting category "${oldCategory.name}"...`);
    try {
        await discord('DELETE', `/channels/${oldCategory.id}`, token);
        console.log(`  - category deleted`);
    } catch (err) {
        console.error(`  ! Failed to delete category: ${err.message}`);
    }

    console.log('\nSUMMARY');
    console.log(`  rows repointed         ${migratedRows}`);
    console.log(`  rows nulled out        ${nulledRows}`);
    console.log(`  channels deleted       ${oldChildren.length}`);
    console.log(`  category deleted       ${oldCategory.name}`);

    await db.end();
})().catch((err) => {
    console.error('\nFAILED:', err.message);
    process.exit(1);
});

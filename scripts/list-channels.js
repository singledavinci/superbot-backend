// Dumps every channel in the guild grouped by category, with ids + types.
const GUILD_ID = process.env.PRIMARY_GUILD_DISCORD_ID || '1417836009202385009';

(async () => {
    const token = process.env.DISCORD_TOKEN;
    if (!token) throw new Error('Missing DISCORD_TOKEN');
    const res = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/channels`, {
        headers: { Authorization: `Bot ${token}`, 'User-Agent': 'SuperBot-Diag/1.0' },
    });
    if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text()}`);
    const channels = await res.json();
    const cats = channels.filter((c) => c.type === 4).sort((a, b) => a.position - b.position);
    const orphan = channels.filter((c) => c.type !== 4 && !c.parent_id);
    console.log(`\nTotal channels: ${channels.length}`);
    console.log(`\nOrphan channels (no parent): ${orphan.length}`);
    for (const c of orphan) console.log(`  type=${c.type} #${c.name} (id=${c.id})`);
    for (const cat of cats) {
        const kids = channels.filter((c) => c.parent_id === cat.id).sort((a, b) => a.position - b.position);
        console.log(`\nCategory "${cat.name}" (id=${cat.id})  — ${kids.length} children`);
        for (const k of kids) console.log(`  type=${k.type} #${k.name} (id=${k.id})`);
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});

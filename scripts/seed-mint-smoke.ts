/**
 * Minimum seed for mint smoke: Guild, User, MintWallet, MintWalletAuthorization.
 * No private keys. No legacy User.encryptedPrivateKey.
 *
 * Env:
 *   DATABASE_URL
 *   SMOKE_GUILD_DISCORD_ID
 *   SMOKE_USER_DISCORD_ID
 *   SMOKE_WALLET_ADDRESS  (0x…, lowercase normalized)
 *   SMOKE_CHAIN_ID        (default 1)
 *
 * Usage:
 *   npx dotenv -e .env -- node --require ts-node/register/transpile-only scripts/seed-mint-smoke.ts
 */
import 'dotenv/config';
import { prisma } from '@superbot/database';

const PERMS = ['preflight', 'prepare', 'schedule', '*'];

async function main(): Promise<void> {
    const guildDiscordId = process.env.SMOKE_GUILD_DISCORD_ID?.trim();
    const userDiscordId = process.env.SMOKE_USER_DISCORD_ID?.trim();
    const walletRaw = process.env.SMOKE_WALLET_ADDRESS?.trim().toLowerCase();
    const chainId = Number(process.env.SMOKE_CHAIN_ID || '1');

    if (!guildDiscordId || !userDiscordId || !walletRaw?.startsWith('0x')) {
        console.error('Set SMOKE_GUILD_DISCORD_ID, SMOKE_USER_DISCORD_ID, SMOKE_WALLET_ADDRESS');
        process.exit(2);
    }

    await prisma.$connect();

    const guild = await prisma.guild.upsert({
        where: { discordId: guildDiscordId },
        create: {
            discordId: guildDiscordId,
            name: `Smoke guild ${guildDiscordId}`,
            planTier: 'FREE',
        },
        update: {},
    });
    console.log('guildId', guild.id, 'discordId', guild.discordId);

    const user = await prisma.user.upsert({
        where: { discordId: userDiscordId },
        create: { discordId: userDiscordId },
        update: {},
    });
    console.log('userId', user.id, 'discordId', user.discordId);

    let wallet = await prisma.mintWallet.findFirst({
        where: { userId: user.id, address: walletRaw, chainId },
    });
    if (!wallet) {
        wallet = await prisma.mintWallet.create({
            data: {
                userId: user.id,
                chainId,
                address: walletRaw,
                signerType: 'simulation-only',
                isExecutionEnabled: false,
            },
        });
        console.log('MintWallet created', wallet.id);
    } else {
        wallet = await prisma.mintWallet.update({
            where: { id: wallet.id },
            data: {
                signerType: 'simulation-only',
                isExecutionEnabled: false,
            },
        });
        console.log('MintWallet updated', wallet.id);
    }

    const existingAuth = await prisma.mintWalletAuthorization.findFirst({
        where: {
            guildId: guild.id,
            userId: user.id,
            mintWalletId: wallet.id,
            revokedAt: null,
        },
    });
    if (!existingAuth) {
        const auth = await prisma.mintWalletAuthorization.create({
            data: {
                guildId: guild.id,
                userId: user.id,
                mintWalletId: wallet.id,
                permissions: PERMS,
            },
        });
        console.log('MintWalletAuthorization created', auth.id);
    } else {
        const auth = await prisma.mintWalletAuthorization.update({
            where: { id: existingAuth.id },
            data: { permissions: PERMS, revokedAt: null },
        });
        console.log('MintWalletAuthorization updated', auth.id);
    }

    await prisma.$disconnect();
    console.log('seed complete');
}

main().catch(e => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
});

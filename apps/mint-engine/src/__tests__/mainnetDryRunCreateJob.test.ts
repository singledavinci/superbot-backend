import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MintExecutionEngine } from '../engine/MintExecutionEngine';
import { mintEnv } from '../config/mintEnv';

describe('createMintJob mainnet_dry_run gates', () => {
    it('rejects invalid chain before DB access', async () => {
        const prisma = {} as import('@superbot/database').PrismaClient;
        const engine = new MintExecutionEngine(prisma, null, null);
        const out = await engine.createMintJob({
            guildDiscordId: 'g_1',
            userDiscordId: 'u_1',
            walletAddress: '0x' + '11'.repeat(20),
            collectionAddress: '0x' + '22'.repeat(20),
            mintContract: '0x' + '22'.repeat(20),
            dropSource: 'opensea',
            dropType: 'public',
            triggerType: 'MANUAL',
            executionMode: 'mainnet_dry_run',
            chainId: 11155111,
            quantity: 1,
        });
        assert.ok('error' in out);
        if ('error' in out) assert.equal(out.error, 'INVALID_CHAIN');
    });

    it('rejects when dry-run disabled', async () => {
        const prev = mintEnv.MINT_MAINNET_DRY_RUN;
        mintEnv.MINT_MAINNET_DRY_RUN = false;
        const prisma = {} as import('@superbot/database').PrismaClient;
        const engine = new MintExecutionEngine(prisma, null, null);
        try {
            const out = await engine.createMintJob({
                guildDiscordId: 'g_1',
                userDiscordId: 'u_1',
                walletAddress: '0x' + '11'.repeat(20),
                collectionAddress: '0x' + '22'.repeat(20),
                mintContract: '0x' + '22'.repeat(20),
                dropSource: 'opensea',
                dropType: 'public',
                triggerType: 'MANUAL',
                executionMode: 'mainnet_dry_run',
                chainId: 1,
                quantity: 1,
            });
            assert.ok('error' in out);
            if ('error' in out) assert.equal(out.error, 'MAINNET_DRY_RUN_DISABLED');
        } finally {
            mintEnv.MINT_MAINNET_DRY_RUN = prev;
        }
    });

    it('rejects when mainnet RPC URL is missing', async () => {
        const prevDry = mintEnv.MINT_MAINNET_DRY_RUN;
        const prevRpc = process.env.MINT_MAINNET_RPC_URL;
        mintEnv.MINT_MAINNET_DRY_RUN = true;
        delete process.env.MINT_MAINNET_RPC_URL;
        const prisma = {} as import('@superbot/database').PrismaClient;
        const engine = new MintExecutionEngine(prisma, null, null);
        try {
            const out = await engine.createMintJob({
                guildDiscordId: 'g_1',
                userDiscordId: 'u_1',
                walletAddress: '0x' + '11'.repeat(20),
                collectionAddress: '0x' + '22'.repeat(20),
                mintContract: '0x' + '22'.repeat(20),
                dropSource: 'opensea',
                dropType: 'public',
                triggerType: 'MANUAL',
                executionMode: 'mainnet_dry_run',
                chainId: 1,
                quantity: 1,
            });
            assert.ok('error' in out);
            if ('error' in out) assert.equal(out.error, 'MAINNET_RPC_REQUIRED');
        } finally {
            mintEnv.MINT_MAINNET_DRY_RUN = prevDry;
            if (prevRpc === undefined) delete process.env.MINT_MAINNET_RPC_URL;
            else process.env.MINT_MAINNET_RPC_URL = prevRpc;
        }
    });

    it('rejects quantity > 1 and beta mismatch before DB access', async () => {
        const prevDry = mintEnv.MINT_MAINNET_DRY_RUN;
        const prevRpc = process.env.MINT_MAINNET_RPC_URL;
        const prevBetaWallet = mintEnv.MINT_MAINNET_BETA_WALLET_ADDRESS;
        const prevBetaGuild = mintEnv.MINT_MAINNET_BETA_GUILD_DISCORD_ID;
        const prevBetaUser = mintEnv.MINT_MAINNET_BETA_USER_DISCORD_ID;

        mintEnv.MINT_MAINNET_DRY_RUN = true;
        process.env.MINT_MAINNET_RPC_URL = 'https://ethereum-rpc.publicnode.com';
        mintEnv.MINT_MAINNET_BETA_WALLET_ADDRESS = ('0x' + 'aa'.repeat(20)).toLowerCase();
        mintEnv.MINT_MAINNET_BETA_GUILD_DISCORD_ID = 'guild_expected';
        mintEnv.MINT_MAINNET_BETA_USER_DISCORD_ID = 'user_expected';

        const prisma = {} as import('@superbot/database').PrismaClient;
        const engine = new MintExecutionEngine(prisma, null, null);
        try {
            const qtyOut = await engine.createMintJob({
                guildDiscordId: 'guild_expected',
                userDiscordId: 'user_expected',
                walletAddress: '0x' + 'aa'.repeat(20),
                collectionAddress: '0x' + '22'.repeat(20),
                mintContract: '0x' + '22'.repeat(20),
                dropSource: 'opensea',
                dropType: 'public',
                triggerType: 'MANUAL',
                executionMode: 'mainnet_dry_run',
                chainId: 1,
                quantity: 2,
            });
            assert.ok('error' in qtyOut);
            if ('error' in qtyOut) assert.equal(qtyOut.error, 'MAINNET_QUANTITY_CAP_EXCEEDED');

            const betaOut = await engine.createMintJob({
                guildDiscordId: 'guild_other',
                userDiscordId: 'user_expected',
                walletAddress: '0x' + 'aa'.repeat(20),
                collectionAddress: '0x' + '22'.repeat(20),
                mintContract: '0x' + '22'.repeat(20),
                dropSource: 'opensea',
                dropType: 'public',
                triggerType: 'MANUAL',
                executionMode: 'mainnet_dry_run',
                chainId: 1,
                quantity: 1,
            });
            assert.ok('error' in betaOut);
            if ('error' in betaOut) assert.equal(betaOut.error, 'MAINNET_BETA_GUILD_MISMATCH');
        } finally {
            mintEnv.MINT_MAINNET_DRY_RUN = prevDry;
            if (prevRpc === undefined) delete process.env.MINT_MAINNET_RPC_URL;
            else process.env.MINT_MAINNET_RPC_URL = prevRpc;
            mintEnv.MINT_MAINNET_BETA_WALLET_ADDRESS = prevBetaWallet;
            mintEnv.MINT_MAINNET_BETA_GUILD_DISCORD_ID = prevBetaGuild;
            mintEnv.MINT_MAINNET_BETA_USER_DISCORD_ID = prevBetaUser;
        }
    });
});

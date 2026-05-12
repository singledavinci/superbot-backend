import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MintExecutionEngine } from '../engine/MintExecutionEngine';
import { mintEnv } from '../config/mintEnv';

const baseLiveArgs = {
    guildDiscordId: 'g_1',
    userDiscordId: 'u_1',
    walletAddress: '0x' + '11'.repeat(20),
    collectionAddress: '0x' + '22'.repeat(20),
    mintContract: '0x' + '22'.repeat(20),
    dropSource: 'opensea',
    dropType: 'public',
    triggerType: 'MANUAL',
    executionMode: 'live' as const,
    chainId: 1,
    quantity: 1,
};

describe('createMintJob live mainnet pre-DB gates', () => {
    it('returns LIVE_EXECUTION_DISABLED when execution not live-enabled', async () => {
        const prevExec = mintEnv.MINT_EXECUTION_ENABLED;
        const prevMode = mintEnv.MINT_ENGINE_MODE;
        mintEnv.MINT_EXECUTION_ENABLED = false;
        mintEnv.MINT_ENGINE_MODE = 'live';
        const prisma = {} as import('@superbot/database').PrismaClient;
        const engine = new MintExecutionEngine(prisma, null, null);
        try {
            const out = await engine.createMintJob({ ...baseLiveArgs });
            assert.ok('error' in out);
            if ('error' in out) assert.equal(out.error, 'LIVE_EXECUTION_DISABLED');
        } finally {
            mintEnv.MINT_EXECUTION_ENABLED = prevExec;
            mintEnv.MINT_ENGINE_MODE = prevMode;
        }
    });

    it('returns MAINNET_DISABLED when testnet-only or broadcast off', async () => {
        const prevExec = mintEnv.MINT_EXECUTION_ENABLED;
        const prevMode = mintEnv.MINT_ENGINE_MODE;
        const prevBroadcast = mintEnv.MINT_MAINNET_BROADCAST_ENABLED;
        const prevTestnetOnly = mintEnv.MINT_TESTNET_ONLY;
        mintEnv.MINT_EXECUTION_ENABLED = true;
        mintEnv.MINT_ENGINE_MODE = 'live';
        mintEnv.MINT_MAINNET_BROADCAST_ENABLED = false;
        mintEnv.MINT_TESTNET_ONLY = false;
        const prisma = {} as import('@superbot/database').PrismaClient;
        const engine = new MintExecutionEngine(prisma, null, null);
        try {
            const out = await engine.createMintJob({ ...baseLiveArgs });
            assert.ok('error' in out);
            if ('error' in out) assert.equal(out.error, 'MAINNET_DISABLED');
        } finally {
            mintEnv.MINT_EXECUTION_ENABLED = prevExec;
            mintEnv.MINT_ENGINE_MODE = prevMode;
            mintEnv.MINT_MAINNET_BROADCAST_ENABLED = prevBroadcast;
            mintEnv.MINT_TESTNET_ONLY = prevTestnetOnly;
        }
    });

    it('returns MAINNET_QUANTITY_CAP_EXCEEDED and MAINNET_BETA_GUILD_MISMATCH before DB', async () => {
        const prevExec = mintEnv.MINT_EXECUTION_ENABLED;
        const prevMode = mintEnv.MINT_ENGINE_MODE;
        const prevBroadcast = mintEnv.MINT_MAINNET_BROADCAST_ENABLED;
        const prevTestnetOnly = mintEnv.MINT_TESTNET_ONLY;
        const prevMainnetBeta = mintEnv.MINT_MAINNET_BETA;
        const prevBetaWallet = mintEnv.MINT_MAINNET_BETA_WALLET_ADDRESS;
        const prevBetaGuild = mintEnv.MINT_MAINNET_BETA_GUILD_DISCORD_ID;
        const prevBetaUser = mintEnv.MINT_MAINNET_BETA_USER_DISCORD_ID;

        mintEnv.MINT_EXECUTION_ENABLED = true;
        mintEnv.MINT_ENGINE_MODE = 'live';
        mintEnv.MINT_MAINNET_BROADCAST_ENABLED = true;
        mintEnv.MINT_TESTNET_ONLY = false;
        mintEnv.MINT_MAINNET_BETA = true;
        mintEnv.MINT_MAINNET_BETA_WALLET_ADDRESS = ('0x' + 'aa'.repeat(20)).toLowerCase();
        mintEnv.MINT_MAINNET_BETA_GUILD_DISCORD_ID = 'guild_ok';
        mintEnv.MINT_MAINNET_BETA_USER_DISCORD_ID = 'user_ok';

        const prisma = {} as import('@superbot/database').PrismaClient;
        const engine = new MintExecutionEngine(prisma, null, null);
        try {
            const qty = await engine.createMintJob({
                ...baseLiveArgs,
                guildDiscordId: 'guild_ok',
                userDiscordId: 'user_ok',
                walletAddress: '0x' + 'aa'.repeat(20),
                quantity: 2,
            });
            assert.ok('error' in qty);
            if ('error' in qty) assert.equal(qty.error, 'MAINNET_QUANTITY_CAP_EXCEEDED');

            const beta = await engine.createMintJob({
                ...baseLiveArgs,
                guildDiscordId: 'wrong_guild',
                userDiscordId: 'user_ok',
                walletAddress: '0x' + 'aa'.repeat(20),
                quantity: 1,
            });
            assert.ok('error' in beta);
            if ('error' in beta) assert.equal(beta.error, 'MAINNET_BETA_GUILD_MISMATCH');
        } finally {
            mintEnv.MINT_EXECUTION_ENABLED = prevExec;
            mintEnv.MINT_ENGINE_MODE = prevMode;
            mintEnv.MINT_MAINNET_BROADCAST_ENABLED = prevBroadcast;
            mintEnv.MINT_TESTNET_ONLY = prevTestnetOnly;
            mintEnv.MINT_MAINNET_BETA = prevMainnetBeta;
            mintEnv.MINT_MAINNET_BETA_WALLET_ADDRESS = prevBetaWallet;
            mintEnv.MINT_MAINNET_BETA_GUILD_DISCORD_ID = prevBetaGuild;
            mintEnv.MINT_MAINNET_BETA_USER_DISCORD_ID = prevBetaUser;
        }
    });

    it('returns TESTNET_CHAIN_MISMATCH for live non-mainnet when testnet-only', async () => {
        const prevExec = mintEnv.MINT_EXECUTION_ENABLED;
        const prevMode = mintEnv.MINT_ENGINE_MODE;
        const prevTestnetOnly = mintEnv.MINT_TESTNET_ONLY;
        const prevDefault = mintEnv.MINT_DEFAULT_CHAIN_ID;
        mintEnv.MINT_EXECUTION_ENABLED = true;
        mintEnv.MINT_ENGINE_MODE = 'live';
        mintEnv.MINT_TESTNET_ONLY = true;
        mintEnv.MINT_DEFAULT_CHAIN_ID = 11155111;
        const prisma = {} as import('@superbot/database').PrismaClient;
        const engine = new MintExecutionEngine(prisma, null, null);
        try {
            // chainId !== 1: mismatch branch runs after mainnet-specific gates (which only apply to chainId 1).
            const out = await engine.createMintJob({
                ...baseLiveArgs,
                chainId: 5,
            });
            assert.ok('error' in out);
            if ('error' in out) assert.equal(out.error, 'TESTNET_CHAIN_MISMATCH');
        } finally {
            mintEnv.MINT_EXECUTION_ENABLED = prevExec;
            mintEnv.MINT_ENGINE_MODE = prevMode;
            mintEnv.MINT_TESTNET_ONLY = prevTestnetOnly;
            mintEnv.MINT_DEFAULT_CHAIN_ID = prevDefault;
        }
    });
});

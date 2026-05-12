import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MintExecutionEngine } from '../engine/MintExecutionEngine';
import { mintEnv } from '../config/mintEnv';

describe('mainnet single-flight', () => {
    it('createMintJob blocks when another active mainnet live job exists for the wallet', async () => {
        const prev = {
            executionEnabled: mintEnv.MINT_EXECUTION_ENABLED,
            engineMode: mintEnv.MINT_ENGINE_MODE,
            mainnetBroadcastEnabled: mintEnv.MINT_MAINNET_BROADCAST_ENABLED,
            testnetOnly: mintEnv.MINT_TESTNET_ONLY,
            mainnetBeta: mintEnv.MINT_MAINNET_BETA,
            betaWallet: mintEnv.MINT_MAINNET_BETA_WALLET_ADDRESS,
            betaGuild: mintEnv.MINT_MAINNET_BETA_GUILD_DISCORD_ID,
            betaUser: mintEnv.MINT_MAINNET_BETA_USER_DISCORD_ID,
        };

        mintEnv.MINT_EXECUTION_ENABLED = true;
        mintEnv.MINT_ENGINE_MODE = 'live';
        mintEnv.MINT_MAINNET_BROADCAST_ENABLED = true;
        mintEnv.MINT_TESTNET_ONLY = false;
        mintEnv.MINT_MAINNET_BETA = true;
        mintEnv.MINT_MAINNET_BETA_WALLET_ADDRESS = ('0x' + '11'.repeat(20)).toLowerCase();
        mintEnv.MINT_MAINNET_BETA_GUILD_DISCORD_ID = 'g_1';
        mintEnv.MINT_MAINNET_BETA_USER_DISCORD_ID = 'u_1';

        let countCalledWith: unknown = null;
        let createCalled = false;

        const prisma = {
            guild: {
                findUnique: async () => ({ id: 'guild_1', discordId: 'g_1' }),
            },
            user: {
                findUnique: async () => ({ id: 'user_1', discordId: 'u_1' }),
            },
            mintWallet: {
                findFirst: async () => ({ id: 'wallet_1', userId: 'user_1', address: '0x' + '11'.repeat(20), chainId: 1 }),
            },
            mainnetExecutionApproval: {
                findFirst: async () => ({
                    id: 'approval_1',
                    guildId: 'guild_1',
                    userId: 'user_1',
                    mintWalletId: 'wallet_1',
                    walletAddress: '0x' + '11'.repeat(20),
                    chainId: 1,
                    approvalStatus: 'active',
                    expiresAt: new Date(Date.now() + 86_400_000),
                    maxFeePerGas: '100000000000',
                    maxPriorityFeePerGas: '2000000000',
                    maxTotalCostNative: '50000000000000000',
                    maxQuantity: 1,
                    allowedCollections: ['0x' + '22'.repeat(20)],
                }),
            },
            mintJob: {
                count: async (args: unknown) => {
                    countCalledWith = args;
                    return 1;
                },
                create: async () => {
                    createCalled = true;
                    return { id: 'job_should_not_create' };
                },
            },
        } as unknown as import('@superbot/database').PrismaClient;

        try {
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
                executionMode: 'live',
                chainId: 1,
                quantity: 1,
            });

            assert.ok('error' in out);
            if ('error' in out) {
                assert.equal(out.error, 'MAINNET_ACTIVE_JOB_LIMIT');
            }
            assert.ok(countCalledWith && typeof countCalledWith === 'object');
            assert.equal(createCalled, false);
        } finally {
            mintEnv.MINT_EXECUTION_ENABLED = prev.executionEnabled;
            mintEnv.MINT_ENGINE_MODE = prev.engineMode;
            mintEnv.MINT_MAINNET_BROADCAST_ENABLED = prev.mainnetBroadcastEnabled;
            mintEnv.MINT_TESTNET_ONLY = prev.testnetOnly;
            mintEnv.MINT_MAINNET_BETA = prev.mainnetBeta;
            mintEnv.MINT_MAINNET_BETA_WALLET_ADDRESS = prev.betaWallet;
            mintEnv.MINT_MAINNET_BETA_GUILD_DISCORD_ID = prev.betaGuild;
            mintEnv.MINT_MAINNET_BETA_USER_DISCORD_ID = prev.betaUser;
        }
    });
});

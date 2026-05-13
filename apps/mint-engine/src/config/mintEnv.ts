import * as dotenv from 'dotenv';

dotenv.config();

function bool(raw: string | undefined, defaultVal: boolean): boolean {
    if (raw === undefined || raw === '') return defaultVal;
    return raw === 'true' || raw === '1';
}

function num(raw: string | undefined, defaultVal: number): number {
    const n = Number(raw);
    return Number.isFinite(n) ? n : defaultVal;
}

/** Central mint engine configuration (safe defaults). */
export const mintEnv = {
    MINT_EXECUTION_ENABLED: bool(process.env.MINT_EXECUTION_ENABLED, false),
    MINT_MAINNET_BROADCAST_ENABLED: bool(process.env.MINT_MAINNET_BROADCAST_ENABLED, false),
    MINT_ENGINE_MODE: (process.env.MINT_ENGINE_MODE || 'simulation').toLowerCase(),
    MINT_REQUIRE_SECURE_SIGNER: bool(process.env.MINT_REQUIRE_SECURE_SIGNER, true),
    MINT_DEFAULT_CHAIN_ID: num(process.env.MINT_DEFAULT_CHAIN_ID, 1),
    MINT_TESTNET_ONLY: bool(process.env.MINT_TESTNET_ONLY, true),
    MINT_EMERGENCY_STOP: bool(process.env.MINT_EMERGENCY_STOP, false),
    MINT_CONFIRMATION_BLOCKS: num(process.env.MINT_CONFIRMATION_BLOCKS, 1),
    MINT_MAX_CONCURRENT_JOBS: num(process.env.MINT_MAX_CONCURRENT_JOBS, 10),
    MINT_MAX_CONCURRENT_PER_WALLET: num(process.env.MINT_MAX_CONCURRENT_PER_WALLET, 1),
    MINT_MAX_RPC_BROADCASTS: num(process.env.MINT_MAX_RPC_BROADCASTS, 3),
    MINT_SCHEDULE_DRIFT_WARN_MS: num(process.env.MINT_SCHEDULE_DRIFT_WARN_MS, 100),
    MINT_SIMULATION_TIMEOUT_MS: num(process.env.MINT_SIMULATION_TIMEOUT_MS, 750),
    MINT_BROADCAST_TIMEOUT_MS: num(process.env.MINT_BROADCAST_TIMEOUT_MS, 500),
    MINT_PROVIDER_FAILOVER_MS: num(process.env.MINT_PROVIDER_FAILOVER_MS, 500),
    MINT_GAS_REFRESH_MS: num(process.env.MINT_GAS_REFRESH_MS, 250),
    MINT_MAX_PRIORITY_FEE_GWEI: process.env.MINT_MAX_PRIORITY_FEE_GWEI || '',
    MINT_MAX_FEE_GWEI: process.env.MINT_MAX_FEE_GWEI || '',
    MINT_MAX_TOTAL_COST_NATIVE: process.env.MINT_MAX_TOTAL_COST_NATIVE || '',
    MINT_ALLOW_PRIVATE_RELAY: bool(process.env.MINT_ALLOW_PRIVATE_RELAY, false),
    MINT_PRIVATE_RELAY_URL: process.env.MINT_PRIVATE_RELAY_URL || '',
    MINT_MEMPOOL_WATCH_ENABLED: bool(process.env.MINT_MEMPOOL_WATCH_ENABLED, true),
    MINT_COPY_PENDING_ENABLED: bool(process.env.MINT_COPY_PENDING_ENABLED, false),
    MINT_COPY_CONFIRMED_ENABLED: bool(process.env.MINT_COPY_CONFIRMED_ENABLED, false),
    MINT_OPENSEA_SEADROP_ENABLED: bool(process.env.MINT_OPENSEA_SEADROP_ENABLED, true),
    MINT_OPENSEA_FCFS_ENABLED: bool(process.env.MINT_OPENSEA_FCFS_ENABLED, true),
    MINT_OPENSEA_GTD_ENABLED: bool(process.env.MINT_OPENSEA_GTD_ENABLED, true),
    MINT_AUDIT_LOG_RETENTION_DAYS: num(process.env.MINT_AUDIT_LOG_RETENTION_DAYS, 90),
    MINT_REPLACEMENT_ENABLED: bool(process.env.MINT_REPLACEMENT_ENABLED, true),
    MINT_MAX_REPLACEMENT_ATTEMPTS: num(process.env.MINT_MAX_REPLACEMENT_ATTEMPTS, 2),
    MINT_REPLACEMENT_BUMP_PERCENT: num(process.env.MINT_REPLACEMENT_BUMP_PERCENT, 15),
    MINT_CLOCK_DRIFT_CHECK_ENABLED: bool(process.env.MINT_CLOCK_DRIFT_CHECK_ENABLED, true),
    MINT_BACKTEST_MODE: bool(process.env.MINT_BACKTEST_MODE, false),
    MINT_HOT_PATH_METRICS_ENABLED: bool(process.env.MINT_HOT_PATH_METRICS_ENABLED, true),
    MINT_PRIVATE_KEY_INPUT_ALLOWED: bool(process.env.MINT_PRIVATE_KEY_INPUT_ALLOWED, false),
    MINT_DISCORD_EXECUTION_BOT_ENABLED: bool(process.env.MINT_DISCORD_EXECUTION_BOT_ENABLED, true),
    MINT_INTELLIGENCE_BOT_EXECUTION_COMMANDS: bool(process.env.MINT_INTELLIGENCE_BOT_EXECUTION_COMMANDS, false),

    MINT_ENGINE_SERVICE_SECRET: (process.env.MINT_ENGINE_SERVICE_SECRET || '').replace(/^\uFEFF/, '').trim(),
    MINT_API_NONCE_REDIS_TTL_SEC: num(process.env.MINT_API_NONCE_REDIS_TTL_SEC, 180),
    MINT_API_MAX_CLOCK_SKEW_SEC: num(process.env.MINT_API_MAX_CLOCK_SKEW_SEC, 60),

    /** Prefer `PORT` (Railway/Heroku) over `MINT_ENGINE_PORT` for HTTP bind. */
    MINT_ENGINE_PORT: num(process.env.PORT || process.env.MINT_ENGINE_PORT, 3847),
    OPENSEA_API_KEY: process.env.OPENSEA_API_KEY || '',

    /** Optional `0x` + 40 hex: overrides default OpenSea CREATE2 SeaDrop minter for `seaDrop()`-less NFT resolution. */
    MINT_SEADROP_CANONICAL: (process.env.MINT_SEADROP_CANONICAL || '').replace(/^\uFEFF/, '').trim(),

    /**
     * Optional checksummed/lowercase `0x` + 40 hex: operator signing wallet for status display and binding checks.
     * Required when `MINT_EXTERNAL_SIGNER_URL` is set (external signer considered configured only with a valid address).
     * Never a private key.
     */
    MINT_SIGNER_ADDRESS: (process.env.MINT_SIGNER_ADDRESS || '').replace(/^\uFEFF/, '').trim().toLowerCase(),

    MINT_TESTNET_LIVE_VERIFIED_AT: process.env.MINT_TESTNET_LIVE_VERIFIED_AT || '',

    /** When true, `mainnet_dry_run` jobs resolve/simulate on mainnet RPC without sign/broadcast. */
    MINT_MAINNET_DRY_RUN: bool(process.env.MINT_MAINNET_DRY_RUN, false),
    /** Comma-separated Discord snowflakes allowed for `/mint-emergency-*` and `/jobs/confirm-mainnet`. */
    MINT_ADMIN_DISCORD_IDS: (process.env.MINT_ADMIN_DISCORD_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    /** Single-wallet mainnet beta: all must match when set (non-empty). */
    MINT_MAINNET_BETA_WALLET_ADDRESS: (process.env.MINT_MAINNET_BETA_WALLET_ADDRESS || '').trim().toLowerCase(),
    MINT_MAINNET_BETA_GUILD_DISCORD_ID: (process.env.MINT_MAINNET_BETA_GUILD_DISCORD_ID || '').trim(),
    MINT_MAINNET_BETA_USER_DISCORD_ID: (process.env.MINT_MAINNET_BETA_USER_DISCORD_ID || '').trim(),
    /** Master switch for controlled one-wallet mainnet beta (live path requires true). */
    MINT_MAINNET_BETA: bool(process.env.MINT_MAINNET_BETA, false),
    MINT_MAINNET_MAX_ACTIVE_JOBS: num(process.env.MINT_MAINNET_MAX_ACTIVE_JOBS, 1),
    MINT_MAINNET_MAX_QUANTITY: num(process.env.MINT_MAINNET_MAX_QUANTITY, 1),
    MINT_MAINNET_COPY_LIVE_ENABLED: bool(process.env.MINT_MAINNET_COPY_LIVE_ENABLED, false),
    MINT_MAINNET_PRIVATE_RELAY_ENABLED: bool(process.env.MINT_MAINNET_PRIVATE_RELAY_ENABLED, false),
    MINT_MAINNET_AUTO_REPLACE_ENABLED: bool(process.env.MINT_MAINNET_AUTO_REPLACE_ENABLED, false),
    MINT_MAINNET_REQUIRE_MANUAL_CONFIRMATION: bool(process.env.MINT_MAINNET_REQUIRE_MANUAL_CONFIRMATION, true),
    /** Preferred beta scoping (falls back to legacy `MINT_MAINNET_BETA_*` names). */
    MINT_MAINNET_BETA_GUILD_ID: (process.env.MINT_MAINNET_BETA_GUILD_ID || '').trim(),
    MINT_MAINNET_BETA_USER_ID: (process.env.MINT_MAINNET_BETA_USER_ID || '').trim(),
    MINT_MAINNET_BETA_WALLET: (process.env.MINT_MAINNET_BETA_WALLET || '').trim().toLowerCase(),
    /** Operator must explicitly approve external signer for mainnet live. */
    MINT_MAINNET_SIGNER_APPROVED: bool(process.env.MINT_MAINNET_SIGNER_APPROVED, false),
    MINT_MAINNET_LOCAL_DEV_SIGNER_APPROVED: bool(process.env.MINT_MAINNET_LOCAL_DEV_SIGNER_APPROVED, false),
    MINT_JOB_MAX_AGE_MINUTES: num(process.env.MINT_JOB_MAX_AGE_MINUTES, 120),
};

/** HTTPS JSON-RPC for Ethereum mainnet (required for mainnet dry-run / live). */
export function resolveMainnetRpcUrl(): string | null {
    const u = process.env.MINT_MAINNET_RPC_URL?.trim();
    return u || null;
}

export function isMintAdminDiscordId(discordId: string): boolean {
    const id = discordId.trim();
    return id.length > 0 && mintEnv.MINT_ADMIN_DISCORD_IDS.includes(id);
}

/** Required for live execution path when enforcing gas / cost caps. */
export function mintGasCapsConfigured(): boolean {
    return (
        !!(mintEnv.MINT_MAX_FEE_GWEI || '').trim() &&
        !!(mintEnv.MINT_MAX_PRIORITY_FEE_GWEI || '').trim() &&
        !!(mintEnv.MINT_MAX_TOTAL_COST_NATIVE || '').trim()
    );
}


export function isLiveEngineMode(): boolean {
    return mintEnv.MINT_ENGINE_MODE === 'live';
}

export function isPrepareEngineMode(): boolean {
    return mintEnv.MINT_ENGINE_MODE === 'prepare';
}

export function resolvedMainnetBetaGuildDiscordId(): string {
    return (mintEnv.MINT_MAINNET_BETA_GUILD_ID || mintEnv.MINT_MAINNET_BETA_GUILD_DISCORD_ID || '').trim();
}

export function resolvedMainnetBetaUserDiscordId(): string {
    return (mintEnv.MINT_MAINNET_BETA_USER_ID || mintEnv.MINT_MAINNET_BETA_USER_DISCORD_ID || '').trim();
}

export function resolvedMainnetBetaWalletAddress(): string {
    return (mintEnv.MINT_MAINNET_BETA_WALLET || mintEnv.MINT_MAINNET_BETA_WALLET_ADDRESS || '').trim().toLowerCase();
}

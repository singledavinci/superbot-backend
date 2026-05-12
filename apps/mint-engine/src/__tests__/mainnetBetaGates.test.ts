import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { evaluateMainnetStrict, type MainnetStrictInput } from '../engine/mainnetLivePolicy';
import { SignerAdapter } from '../engine/SignerAdapter';
import { BroadcastEngine } from '../engine/BroadcastEngine';
import { assertMainnetBroadcastAllowed } from '../engine/mainnetGuard';
import { mintEnv } from '../config/mintEnv';

let prevMainnetRpc: string | undefined;

before(() => {
    prevMainnetRpc = process.env.MINT_MAINNET_RPC_URL;
    process.env.MINT_MAINNET_RPC_URL = 'https://ethereum-rpc.publicnode.com';
});

after(() => {
    if (prevMainnetRpc === undefined) delete process.env.MINT_MAINNET_RPC_URL;
    else process.env.MINT_MAINNET_RPC_URL = prevMainnetRpc;
});

function baseLiveInput(overrides: Partial<MainnetStrictInput> = {}): MainnetStrictInput {
    return {
        chainId: 1,
        phase: 'live',
        emergencyStopActive: false,
        executionEnabled: true,
        engineModeLive: true,
        mainnetBroadcastEnabled: true,
        testnetOnly: false,
        mainnetBetaEnabled: true,
        requireSecureSigner: true,
        walletMainnetApproved: true,
        signerConfigured: true,
        signerMainnetApproved: true,
        simulationPass: true,
        gasCapsConfigured: true,
        maxTotalCostSet: true,
        maxFeePerGasSet: true,
        maxPriorityFeePerGasSet: true,
        providerHealthy: true,
        operatorConfirmationPresent: true,
        jobExpired: false,
        dropVerified: true,
        betaGuildOk: true,
        betaUserOk: true,
        betaWalletOk: true,
        quantityOk: true,
        concurrentJobsOk: true,
        copyMintDisabledOk: true,
        privateRelayDisabledOk: true,
        ...overrides,
    };
}

describe('Mainnet beta — evaluateMainnetStrict', () => {
    it('returns null for chainId !== 1', () => {
        assert.equal(evaluateMainnetStrict({ ...baseLiveInput(), chainId: 11155111 }), null);
    });

    it('live: blocks when testnetOnly', () => {
        const r = evaluateMainnetStrict(baseLiveInput({ testnetOnly: true }));
        assert.equal(r, 'MAINNET_DISABLED');
    });

    it('live: blocks when mainnetBroadcast disabled', () => {
        const r = evaluateMainnetStrict(baseLiveInput({ mainnetBroadcastEnabled: false }));
        assert.equal(r, 'MAINNET_DISABLED');
    });

    it('live: blocks when mainnet RPC is missing', () => {
        const prev = process.env.MINT_MAINNET_RPC_URL;
        try {
            delete process.env.MINT_MAINNET_RPC_URL;
            const r = evaluateMainnetStrict(baseLiveInput());
            assert.equal(r, 'MAINNET_RPC_REQUIRED');
        } finally {
            if (prev === undefined) delete process.env.MINT_MAINNET_RPC_URL;
            else process.env.MINT_MAINNET_RPC_URL = prev;
        }
    });

    it('live: blocks when wallet not approved', () => {
        const r = evaluateMainnetStrict(baseLiveInput({ walletMainnetApproved: false }));
        assert.equal(r, 'MAINNET_WALLET_NOT_APPROVED');
    });

    it('live: blocks when signer not approved', () => {
        const r = evaluateMainnetStrict(baseLiveInput({ signerMainnetApproved: false }));
        assert.equal(r, 'MAINNET_SIGNER_NOT_APPROVED');
    });

    it('live: blocks when gas caps missing', () => {
        const r = evaluateMainnetStrict(baseLiveInput({ gasCapsConfigured: false }));
        assert.equal(r, 'MAINNET_GAS_CAP_REQUIRED');
    });

    it('live: blocks when max total cost missing', () => {
        const r = evaluateMainnetStrict(baseLiveInput({ maxTotalCostSet: false }));
        assert.equal(r, 'MAINNET_COST_CAP_REQUIRED');
    });

    it('live: blocks when simulation not pass', () => {
        const r = evaluateMainnetStrict(baseLiveInput({ simulationPass: false }));
        assert.equal(r, 'MAINNET_SIMULATION_REQUIRED');
    });

    it('live: blocks when provider unhealthy', () => {
        const r = evaluateMainnetStrict(baseLiveInput({ providerHealthy: false }));
        assert.equal(r, 'MAINNET_PROVIDER_UNHEALTHY');
    });

    it('live: blocks when emergency stop', () => {
        const r = evaluateMainnetStrict(baseLiveInput({ emergencyStopActive: true }));
        assert.equal(r, 'MAINNET_EMERGENCY_STOP_ACTIVE');
    });

    it('live: blocks when operator confirmation missing', () => {
        const r = evaluateMainnetStrict(baseLiveInput({ operatorConfirmationPresent: false }));
        assert.equal(r, 'MAINNET_CONFIRMATION_REQUIRED');
    });

    it('live: blocks copy-mint pending', () => {
        const r = evaluateMainnetStrict(baseLiveInput({ copyMintDisabledOk: false }));
        assert.equal(r, 'MAINNET_COPY_MINT_BLOCKED');
    });

    it('live: blocks private relay', () => {
        const r = evaluateMainnetStrict(baseLiveInput({ privateRelayDisabledOk: false }));
        assert.equal(r, 'MAINNET_PRIVATE_RELAY_BLOCKED');
    });

    it('dry_run: blocks when emergency stop active', () => {
        const r = evaluateMainnetStrict({
            ...baseLiveInput(),
            phase: 'dry_run',
            emergencyStopActive: true,
        });
        assert.equal(r, 'MAINNET_EMERGENCY_STOP_ACTIVE');
    });
});

describe('Mainnet beta — signer and broadcast emergency', () => {
    it('SignerAdapter refuses sign when runtime emergency flag passed', async () => {
        const s = new SignerAdapter();
        const r = await s.signApprovedPlan({
            planHash: 'a'.repeat(64),
            approvedPlanHash: 'a'.repeat(64),
            mode: 'local-dev-signer',
            unsigned: {
                chainId: 11155111,
                to: '0x' + '11'.repeat(20),
                data: '0x',
                value: 0n,
                gasLimit: 21_000n,
                maxFeePerGas: 1n,
                maxPriorityFeePerGas: 1n,
                nonce: 0,
            },
            chainId: 11155111,
            emergencyStopActive: true,
        });
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.code, 'EXECUTION_EMERGENCY_STOP');
    });

    it('BroadcastEngine refuses send when emergencyStopActive', async () => {
        const b = new BroadcastEngine();
        const raw = '0x00' as `0x${string}`;
        const out = await b.broadcastRaw({
            rawTransaction: raw as `0x${string}`,
            urls: ['http://127.0.0.1:9'],
            emergencyStopActive: true,
        });
        assert.equal(out[0]?.ok, false);
        assert.equal(out[0]?.error, 'MAINNET_EMERGENCY_STOP_ACTIVE');
    });
});

describe('Mainnet beta — mainnetGuard', () => {
    it('throws MAINNET_DISABLED when testnet-only or broadcast off', () => {
        if (mintEnv.MINT_TESTNET_ONLY || !mintEnv.MINT_MAINNET_BROADCAST_ENABLED) {
            assert.throws(() => assertMainnetBroadcastAllowed(1), /MAINNET_DISABLED/);
        }
    });
});

describe('Mainnet beta — dry-run safety invariants', () => {
    it('executeMainnetDryRunJob path contains no signing or broadcast calls', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'MintExecutionEngine.ts'), 'utf8');
        const start = src.indexOf('async executeMainnetDryRunJob(');
        const end = src.indexOf('async executeLiveMintJob(');
        assert.ok(start >= 0 && end > start, 'dry-run and live methods must exist');
        const dryRunChunk = src.slice(start, end);
        assert.equal(dryRunChunk.includes('signApprovedPlan('), false);
        assert.equal(dryRunChunk.includes('broadcastRaw('), false);
    });
});

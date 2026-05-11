import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ZeroAddress } from 'ethers';
import { decodePublicDrop, isActiveSeadropAllowlistRoot, MINT_PUBLIC_SELECTOR } from '../engine/seaDropAbi';
import { TransactionPlanner } from '../engine/TransactionPlanner';
import { TransactionBuilder } from '../engine/TransactionBuilder';
import { ExecutionPolicyEngine } from '../engine/ExecutionPolicyEngine';
import { mintEnv } from '../config/mintEnv';
import { SimulationEngine } from '../engine/SimulationEngine';
import { MintExecutionEngine } from '../engine/MintExecutionEngine';
import type { ResolvedDrop } from '../engine/mintTypes';

const ZERO32 = '0x' + '00'.repeat(32);
const NONZERO32 = '0x' + '01' + '00'.repeat(31);

function basePublicResolvedDrop(overrides: Partial<ResolvedDrop> = {}): ResolvedDrop {
    const sea = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const nft = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    return {
        chainId: 1,
        collectionAddress: nft,
        nftContract: nft,
        seaDropContract: sea,
        mintContract: sea,
        source: 'seadrop',
        dropType: 'public',
        startTime: 1_700_000_000_000,
        endTime: null,
        priceNative: '1000000000000000',
        maxPerWallet: 5,
        maxSupply: null,
        stageId: 'public',
        requiresProof: false,
        requiresSignature: false,
        functionSelector: MINT_PUBLIC_SELECTOR,
        mintFunction: 'mintPublic',
        openSeaCollectionSlug: 'test',
        feeRecipient: ZeroAddress,
        restrictFeeRecipients: false,
        ...overrides,
    };
}

describe('Phase 3 — SeaDrop decode & allowlist guard', () => {
    it('decodePublicDrop parses on-chain tuple array (public stage)', () => {
        const raw = [1_000_000_000_000_000n, 1n, 2n, 3n, 0n, false];
        const pd = decodePublicDrop(raw);
        assert.ok(pd);
        assert.equal(pd.mintPrice, 1_000_000_000_000_000n);
        assert.equal(pd.maxTotalMintableByWallet, 3n);
        assert.equal(pd.restrictFeeRecipients, false);
    });

    it('isActiveSeadropAllowlistRoot fails closed when merkle root is set', () => {
        assert.equal(isActiveSeadropAllowlistRoot(ZERO32), false);
        assert.equal(isActiveSeadropAllowlistRoot(NONZERO32), true);
    });
});

describe('Phase 3 — TransactionPlanner', () => {
    const planner = new TransactionPlanner();

    it('FAIL_UNKNOWN_PRICE when price is missing', () => {
        const drop = basePublicResolvedDrop({ priceNative: null });
        const r = planner.buildPlan({
            chainId: 1,
            executionMode: 'prepare',
            drop,
            walletAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
            quantity: 1,
        });
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.code, 'FAIL_UNKNOWN_PRICE');
    });

    it('FAIL_UNKNOWN_FUNCTION when mint function is not mintPublic', () => {
        const drop = basePublicResolvedDrop({ mintFunction: null });
        const r = planner.buildPlan({
            chainId: 1,
            executionMode: 'prepare',
            drop,
            walletAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
            quantity: 1,
        });
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.code, 'FAIL_UNKNOWN_FUNCTION');
    });

    it('WRONG_CHAIN is rejected', () => {
        const drop = basePublicResolvedDrop({ chainId: 11155111 });
        const r = planner.buildPlan({
            chainId: 1,
            executionMode: 'prepare',
            drop,
            walletAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
            quantity: 1,
        });
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.code, 'WRONG_CHAIN');
    });

    it('INVALID_QUANTITY when quantity exceeds max per wallet', () => {
        const drop = basePublicResolvedDrop({ maxPerWallet: 2 });
        const r = planner.buildPlan({
            chainId: 1,
            executionMode: 'prepare',
            drop,
            walletAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
            quantity: 3,
        });
        assert.equal(r.ok, false);
        if (!r.ok) assert.equal(r.code, 'INVALID_QUANTITY');
    });

    it('plan hash is stable for identical inputs', () => {
        const drop = basePublicResolvedDrop();
        const a = planner.buildPlan({
            chainId: 1,
            executionMode: 'prepare',
            drop,
            walletAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
            quantity: 1,
            gasLimit: 350_000n,
            maxFeePerGasWei: 10n,
            maxPriorityFeePerGasWei: 1n,
        });
        const b = planner.buildPlan({
            chainId: 1,
            executionMode: 'prepare',
            drop,
            walletAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
            quantity: 1,
            gasLimit: 350_000n,
            maxFeePerGasWei: 10n,
            maxPriorityFeePerGasWei: 1n,
        });
        assert.ok(a.ok && b.ok);
        if (a.ok && b.ok) assert.equal(a.planHash, b.planHash);
    });
});

describe('Phase 3 — TransactionBuilder', () => {
    it('builds unsigned tx and prepare payload without fetching ABI', () => {
        const planner = new TransactionPlanner();
        const drop = basePublicResolvedDrop();
        const built = planner.buildPlan({
            chainId: 1,
            executionMode: 'prepare',
            drop,
            walletAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
            quantity: 2,
        });
        assert.ok(built.ok);
        if (!built.ok) return;
        const builder = new TransactionBuilder();
        const unsigned = builder.buildUnsigned(built.plan);
        assert.ok(unsigned.data.startsWith('0x'));
        assert.ok(unsigned.value > 0n);
        const prep = builder.buildPreparePayload(built.plan);
        assert.equal(prep.kind, 'unsigned_eip1559_tx');
        assert.equal(prep.chainId, 1);
    });

    it('does not build when calldata is missing', () => {
        const planner = new TransactionPlanner();
        const drop = basePublicResolvedDrop();
        const built = planner.buildPlan({
            chainId: 1,
            executionMode: 'prepare',
            drop,
            walletAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
            quantity: 1,
        });
        assert.ok(built.ok);
        if (!built.ok) return;
        const bad = { ...built.plan, calldata: '0x' as `0x${string}` };
        const builder = new TransactionBuilder();
        assert.throws(() => builder.buildUnsigned(bad), /PLAN_MISSING_CALLDATA/);
    });
});

describe('Phase 3 — SimulationEngine', () => {
    it('maps revert messages to structured statuses', () => {
        const sim = new SimulationEngine(null);
        return sim.simulate('0x' + '11'.repeat(20), { chainId: 1, to: ZeroAddress, data: '0x', value: 0n, gasLimit: 21_000n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }).then(res => {
            assert.equal(res.status, 'DEGRADED_PROVIDER_ERROR');
        });
    });
});

describe('Phase 3 — ExecutionPolicyEngine', () => {
    it('simulation failure blocks live execution (never allows live when sim failed)', () => {
        const policy = new ExecutionPolicyEngine();
        const d = policy.decideLive({
            walletAuthorized: true,
            simulationOk: false,
            simulationStatus: 'FAIL_REVERT',
            signerConfigured: true,
            nonceOk: true,
            clockDriftOk: true,
            chainId: 11155111,
        });
        assert.notEqual(d, 'ALLOW_LIVE_EXECUTION');
        if (mintEnv.MINT_EXECUTION_ENABLED && !mintEnv.MINT_EMERGENCY_STOP) {
            assert.equal(d, 'BLOCK_SIMULATION');
        }
    });
});

describe('Phase 3 — prepare-only job policy', () => {
    it('createMintJob rejects live before hitting the database', async () => {
        const prisma = {} as import('@superbot/database').PrismaClient;
        const engine = new MintExecutionEngine(prisma, null, null);
        const r = await engine.createMintJob({
            guildDiscordId: 'g',
            userDiscordId: 'u',
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
        assert.ok('error' in r);
        if ('error' in r) assert.equal(r.error, 'LIVE_EXECUTION_DISABLED');
    });
});

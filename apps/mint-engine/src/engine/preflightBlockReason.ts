/**
 * Human-readable block reasons for mint preflight (API + Discord).
 * Maps engine / resolver codes without guessing eligibility outcomes.
 */
export function preflightBlockReasonFromCode(code: string, message?: string): string {
    const m = message?.trim();
    const suffix = m ? `: ${m}` : '';
    switch (code) {
        case 'FAIL_UNKNOWN_PRICE':
            return `Unknown mint price (wei). Resolver could not determine a safe unit price${suffix}`;
        case 'FAIL_UNKNOWN_FUNCTION':
            return `Unknown or unsupported mint function (not a verified SeaDrop mintPublic path)${suffix}`;
        case 'FAIL_MISSING_PROOF':
            return `Missing or unverified merkle proof / server-signed mint path${suffix}`;
        case 'FAIL_NOT_ELIGIBLE':
            return `Wallet or fee-recipient configuration is not eligible for this drop${suffix}`;
        case 'DEGRADED_PROVIDER_ERROR':
            return `Provider or RPC unavailable (HTTPS RPC and/or OpenSea API required for SeaDrop verification)${suffix}`;
        case 'CHAIN_UNSUPPORTED':
            return `Chain is not supported for SeaDrop resolution${suffix}`;
        case 'DROP_SOURCE_UNSUPPORTED':
            return `Drop source is not supported${suffix}`;
        case 'GUILD_NOT_FOUND':
            return 'Guild is not registered in the database';
        case 'USER_NOT_FOUND':
            return 'User is not registered in the database';
        case 'MINT_WALLET_NOT_FOUND':
            return 'Mint wallet not found for this user and chain';
        case 'BLOCK_WALLET_NOT_AUTHORIZED':
        case 'WALLET_NOT_AUTHORIZED':
            return 'Wallet is not authorized for preflight in this guild';
        case 'WRONG_CHAIN':
            return 'Request chainId does not match resolved drop chain';
        case 'INVALID_QUANTITY':
            return 'Quantity is invalid or exceeds max per wallet';
        case 'BUILD_TX_FAILED':
            return `Could not build unsigned transaction${suffix}`;
        default:
            if (code.startsWith('BLOCK_')) return `Policy blocked: ${code}${suffix}`;
            if (code.startsWith('FAIL_')) return `Preflight failed: ${code}${suffix}`;
            return `Blocked: ${code}${suffix}`;
    }
}

export function simulationBlockReason(status: string, revertReason?: string | null): string | null {
    if (status === 'PASS' || status === 'PASS_STAGE_NOT_OPEN_YET') return null;
    const r = revertReason?.trim();
    const tail = r ? ` (${r})` : '';
    switch (status) {
        case 'FAIL_REVERT':
            return `Simulation reverted${tail}`;
        case 'FAIL_NOT_ELIGIBLE':
            return `Simulation indicates not eligible${tail}`;
        case 'FAIL_MISSING_PROOF':
            return `Simulation indicates missing proof${tail}`;
        case 'FAIL_WALLET_LIMIT':
            return `Simulation indicates wallet mint limit${tail}`;
        case 'FAIL_SOLD_OUT':
            return 'Simulation indicates sold out';
        case 'FAIL_INSUFFICIENT_FUNDS':
            return 'Simulation indicates insufficient funds for value + gas';
        case 'FAIL_GAS_CAP':
            return 'Simulation indicates gas fee cap issue';
        case 'FAIL_UNKNOWN_FUNCTION':
            return 'Simulation indicates unknown function / selector mismatch';
        case 'FAIL_UNKNOWN_PRICE':
            return 'Simulation indicates unknown price / value mismatch';
        case 'DEGRADED_PROVIDER_ERROR':
            return `Simulation could not complete (provider)${tail}`;
        default:
            return `Simulation status: ${status}${tail}`;
    }
}

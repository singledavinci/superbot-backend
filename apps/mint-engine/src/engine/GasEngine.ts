import { JsonRpcProvider, parseUnits } from 'ethers';
import { mintEnv } from '../config/mintEnv';

export interface GasStrategy {
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    gasLimit: bigint;
    estimatedTotalCostWei: bigint;
}

export class GasEngine {
    constructor(private rpcUrl: string | null) {}

    async buildStrategy(args: { gasLimit: bigint; urgency: 'conservative' | 'balanced' | 'aggressive' }): Promise<GasStrategy> {
        let maxFee = parseUnits(mintEnv.MINT_MAX_FEE_GWEI || '500', 'gwei');
        let tip = parseUnits(mintEnv.MINT_MAX_PRIORITY_FEE_GWEI || '50', 'gwei');
        if (this.rpcUrl) {
            try {
                const p = new JsonRpcProvider(this.rpcUrl);
                const fee = await p.getFeeData();
                if (fee.maxFeePerGas && fee.maxPriorityFeePerGas) {
                    maxFee = fee.maxFeePerGas;
                    tip = fee.maxPriorityFeePerGas;
                    if (args.urgency === 'aggressive') {
                        maxFee = (maxFee * 115n) / 100n;
                        tip = (tip * 115n) / 100n;
                    }
                    if (args.urgency === 'conservative') {
                        maxFee = (maxFee * 95n) / 100n;
                        tip = (tip * 95n) / 100n;
                    }
                }
            } catch {
                /* use caps */
            }
        }
        if (mintEnv.MINT_MAX_FEE_GWEI) {
            const cap = parseUnits(mintEnv.MINT_MAX_FEE_GWEI, 'gwei');
            if (maxFee > cap) maxFee = cap;
        }
        if (mintEnv.MINT_MAX_PRIORITY_FEE_GWEI) {
            const capTip = parseUnits(mintEnv.MINT_MAX_PRIORITY_FEE_GWEI, 'gwei');
            if (tip > capTip) tip = capTip;
        }
        return {
            maxFeePerGas: maxFee,
            maxPriorityFeePerGas: tip,
            gasLimit: args.gasLimit,
            estimatedTotalCostWei: args.gasLimit * maxFee,
        };
    }
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SniperEngine = void 0;
const ethers_1 = require("ethers");
/**
 * High-performance NFT Sniper Engine
 * Ported from the SuperBot Sniper Core for ultra-fast execution.
 */
class SniperEngine {
    provider;
    constructor(provider) {
        this.provider = provider;
    }
    async executeCopyTrade(privateKey, to, data, value, options = {}) {
        const wallet = new ethers_1.Wallet(privateKey, this.provider);
        // 1. Value/Limit Guard
        if (options.maxMintLimit && options.maxMintLimit > 0) {
            if (parseFloat((0, ethers_1.formatEther)(value)) > options.maxMintLimit) {
                throw new Error(`Slippage Guard: Value ${(0, ethers_1.formatEther)(value)} exceeds limit ${options.maxMintLimit}`);
            }
        }
        // 2. Gas Logic (Aggressive Bidding)
        const currentFee = await this.provider.getFeeData();
        let priorityFee = currentFee.maxPriorityFeePerGas || 100000000n;
        let maxFee = currentFee.maxFeePerGas ? (currentFee.maxFeePerGas * 120n) / 100n : 50000000000n;
        if (options.gasBribeGwei && options.gasBribeGwei > 0) {
            const bribeWei = (0, ethers_1.parseUnits)(options.gasBribeGwei.toString(), 'gwei');
            priorityFee += bribeWei;
            maxFee += bribeWei;
        }
        const txObj = {
            to,
            data,
            value,
            maxFeePerGas: maxFee,
            maxPriorityFeePerGas: priorityFee,
            nonce: options.nonce,
            gasLimit: 300000n // Standard safety limit
        };
        // 3. Execution
        try {
            // Optional: Simulation pre-flight
            if (!options.skipSimulation) {
                await this.provider.estimateGas({ ...txObj, from: wallet.address });
            }
            const tx = await wallet.sendTransaction(txObj);
            console.log(`🚀 [Sniper] Transaction broadcasted: ${tx.hash}`);
            return tx;
        }
        catch (err) {
            console.error(`❌ [Sniper] Execution failed:`, err.message);
            throw err;
        }
    }
    /**
     * Attempts to 'Hijack' the payload if it's a known router or contains the whale address.
     */
    async preparePayload(data, whaleAddress, myAddress) {
        let finalData = data;
        const paddedWhale = whaleAddress.toLowerCase().replace('0x', '').padStart(64, '0');
        const paddedMine = myAddress.toLowerCase().replace('0x', '').padStart(64, '0');
        if (finalData.toLowerCase().includes(paddedWhale)) {
            finalData = finalData.toLowerCase().replace(new RegExp(paddedWhale, 'g'), paddedMine);
            console.log(`[Sniper] 🛡️ Whale address deep-swapped in payload.`);
        }
        // Handle SeaDrop Hijack
        if (finalData.startsWith('0x51061988') || finalData.startsWith('0x46332f08')) {
            const coder = new ethers_1.AbiCoder();
            const nft = '0x' + finalData.slice(34, 74);
            const feeRecipient = '0x' + finalData.slice(98, 138);
            const quantity = BigInt('0x' + finalData.slice(202, 266));
            finalData = '0x51061988' + coder.encode(['address', 'address', 'address', 'uint256'], [nft, feeRecipient, myAddress, quantity]).slice(2);
        }
        return finalData;
    }
}
exports.SniperEngine = SniperEngine;
//# sourceMappingURL=sniper.js.map
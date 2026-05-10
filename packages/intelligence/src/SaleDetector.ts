import { JsonRpcProvider, Interface, Log } from 'ethers';

export interface SaleInfo {
    isSale: boolean;
    price?: string;
    currency?: string;
    marketplace?: string;
}

export class SaleDetector {
    private provider: JsonRpcProvider;
    private openseaIface: Interface;
    private blurIface: Interface;

    constructor(rpcUrl: string) {
        this.provider = new JsonRpcProvider(rpcUrl);
        
        // OpenSea Seaport 1.5/1.6
        this.openseaIface = new Interface([
            "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)"
        ]);
        
        // Blur Execution 2
        this.blurIface = new Interface([
            "event Execution721(address maker, address taker, address collection, uint256 tokenId, uint256 price)"
        ]);
    }

    /**
     * Detects if a transfer was part of a verified sale by inspecting the transaction logs.
     */
    public async detectSale(txHash: string): Promise<SaleInfo> {
        try {
            const receipt = await this.provider.getTransactionReceipt(txHash);
            if (!receipt) return { isSale: false };

            for (const log of receipt.logs) {
                // Check OpenSea Seaport
                try {
                    const decoded = this.openseaIface.parseLog(log as any);
                    if (decoded && decoded.name === 'OrderFulfilled') {
                        // Very basic price estimation from consideration
                        const ethConsideration = decoded.args.consideration.find((c: any) => c.token === '0x0000000000000000000000000000000000000000');
                        return {
                            isSale: true,
                            price: ethConsideration ? (BigInt(ethConsideration.amount).toString()) : '0',
                            currency: 'ETH',
                            marketplace: 'OpenSea'
                        };
                    }
                } catch (e) {}

                // Check Blur
                try {
                    const decoded = this.blurIface.parseLog(log as any);
                    if (decoded && decoded.name === 'Execution721') {
                        return {
                            isSale: true,
                            price: decoded.args.price.toString(),
                            currency: 'ETH',
                            marketplace: 'Blur'
                        };
                    }
                } catch (e) {}
            }

            return { isSale: false };
        } catch (error) {
            console.error(`[SaleDetector] Error detecting sale for ${txHash}:`, error);
            return { isSale: false };
        }
    }
}

import axios from 'axios';

export interface FloorData {
    floorPrice: number;
    currency: string;
    collectionName: string;
}

export class FloorProvider {
    private apiKey: string;
    private baseUrl: string;

    constructor() {
        this.apiKey = process.env.THIRD_PARTY_API_KEY || '';
        this.baseUrl = 'https://api.reservoir.tools'; // Default to Reservoir
    }

    /**
     * Fetches current floor price for a collection.
     */
    public async getFloorPrice(contract: string, chain: string = 'ethereum'): Promise<FloorData | null> {
        try {
            // For MVP, we use Reservoir API (Free tier/Public often works for basic floor)
            const response = await axios.get(`${this.baseUrl}/collections/v7`, {
                params: { id: contract },
                headers: { 'x-api-key': this.apiKey }
            });

            const collection = response.data.collections[0];
            if (!collection) return null;

            return {
                floorPrice: collection.floorAsk.price.amount.native,
                currency: collection.floorAsk.price.currency.symbol,
                collectionName: collection.name
            };
        } catch (error) {
            console.error(`[FloorProvider] Failed to fetch floor for ${contract}:`, error);
            return null;
        }
    }
}

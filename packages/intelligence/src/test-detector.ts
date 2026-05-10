import { SaleDetector } from './SaleDetector';
import * as dotenv from 'dotenv';

dotenv.config();

async function testSaleDetector() {
    const detector = new SaleDetector(process.env.WSS_RPC_URL || '');
    
    // Example transaction hashes (replace with real ones for actual testing)
    const testCases = [
        { 
            hash: '0x...', // Replace with a real OpenSea sale hash
            description: 'OpenSea Seaport Sale'
        },
        {
            hash: '0x...', // Replace with a real Blur sale hash
            description: 'Blur Sale'
        },
        {
            hash: '0x...', // Replace with a real Mint hash
            description: 'Direct Mint'
        }
    ];

    console.log('🧪 Testing SaleDetector...');

    for (const test of testCases) {
        if (test.hash === '0x...') continue;
        
        console.log(`\nChecking: ${test.description} (${test.hash})`);
        try {
            const result = await detector.detectSale(test.hash);
            console.log('Result:', JSON.stringify(result, null, 2));
        } catch (err) {
            console.error('Failed:', err);
        }
    }
}

if (require.main === module) {
    testSaleDetector();
}

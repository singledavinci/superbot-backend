"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const intelligence_1 = require("../intelligence");
async function runLocalTests() {
    console.log('🧪 Starting Local Business Logic Tests (Mocked DB & Queue)\n');
    const engine = new intelligence_1.ContextEngine();
    // Test 1: Wash Trade Detection
    console.log('--- Test 1: Wash Trade Detection ---');
    const isWash = engine.detectWashTrade('0x123', '0x123', false, 10);
    console.log(`Expected: true, Actual: ${isWash} -> ${isWash ? '✅ PASS' : '❌ FAIL'}`);
    // Test 2: Strong Bullish Context
    console.log('\n--- Test 2: Strong Bullish Context ---');
    const bullishReport = engine.analyzeWhaleBuy({ address: '0x123', winRate: 0.85, totalFlips: 20, realizedProfit: 10 }, true, // First entry
    0.06, // +6% floor
    -0.10, // -10% listings
    25 // 25 unique buyers (healthy)
    );
    console.log(`Expected Grade: Strong Bullish, Actual: ${bullishReport.grade} -> ${bullishReport.grade === 'Strong Bullish' ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`Context: ${bullishReport.context}`);
    console.log(`Risk: ${bullishReport.risk || 'None'}`);
    // Test 3: High Risk Context
    console.log('\n--- Test 3: High Risk Context (Low Unique Buyers) ---');
    const riskReport = engine.analyzeWhaleBuy({ address: '0x123', winRate: 0.70, totalFlips: 10, realizedProfit: 2 }, false, // Not first entry
    0.08, // +8% floor
    -0.05, // -5% listings
    5 // 5 unique buyers (low volume / high risk)
    );
    // Grade will be High Risk because uniqueBuyers < 15, overriding the Strong Bullish
    console.log(`Expected Grade: High Risk, Actual: ${riskReport.grade} -> ${riskReport.grade === 'High Risk' ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`Context: ${riskReport.context}`);
    console.log(`Risk: ${riskReport.risk}`);
    console.log('\n✅ Local Business Logic Tests Complete');
}
runLocalTests().catch(console.error);

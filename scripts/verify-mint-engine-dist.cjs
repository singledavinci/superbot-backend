/**
 * Fails the build if compiled mint-engine output does not include the expanded
 * GET /health/mint-engine implementation. Catches stale deploys / wrong entrypoints early.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const serverJs = path.join(root, 'dist/apps/mint-engine/src/server.js');
const payloadJs = path.join(root, 'dist/apps/mint-engine/src/http/mintEngineHealthPayload.js');

function fail(msg) {
    console.error('[verify-mint-engine-dist]', msg);
    process.exit(1);
}

if (!fs.existsSync(serverJs)) fail(`missing ${serverJs} — run npm run build`);
if (!fs.existsSync(payloadJs)) fail(`missing ${payloadJs} — run npm run build`);

const serverSrc = fs.readFileSync(serverJs, 'utf8');
const payloadSrc = fs.readFileSync(payloadJs, 'utf8');

if (!serverSrc.includes('mintEngineHealthPayload')) {
    fail('dist server.js does not load mintEngineHealthPayload');
}
if (!payloadSrc.includes('mainnetBroadcastEnabled')) {
    fail('dist mintEngineHealthPayload.js missing mainnetBroadcastEnabled');
}
if (!payloadSrc.includes('healthSchemaVersion')) {
    fail('dist mintEngineHealthPayload.js missing healthSchemaVersion');
}
if (!payloadSrc.includes('runtimeEmergencyStopAvailable')) {
    fail('dist mintEngineHealthPayload.js missing runtimeEmergencyStopAvailable');
}
if (!payloadSrc.includes('signerMode')) {
    fail('dist mintEngineHealthPayload.js missing signerMode');
}
if (!payloadSrc.includes('healthSchemaVersion: 3')) {
    fail('dist mintEngineHealthPayload.js must use healthSchemaVersion 3');
}

console.log('[verify-mint-engine-dist] OK');

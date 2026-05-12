'use strict';
/**
 * Sets SERVICE_TYPE before loading the compiled router (works on Windows PowerShell/cmd
 * where `SERVICE_TYPE=value node ...` is not supported).
 */
const path = require('path');

const serviceType = process.argv[2];
if (!serviceType || serviceType.startsWith('-')) {
    console.error('Usage: node scripts/run-service.cjs <SERVICE_TYPE>');
    console.error('Examples:');
    console.error('  npm run start:mint-executor-bot');
    console.error('  npm run start:mint-engine');
    process.exit(1);
}

process.env.SERVICE_TYPE = serviceType;
require(path.join(__dirname, '..', 'dist', 'src', 'index.js'));

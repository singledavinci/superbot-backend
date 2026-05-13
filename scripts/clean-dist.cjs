'use strict';
/**
 * Remove stale compiled output. `tsc` does not delete old .js when sources are renamed/removed,
 * which can leave orphan command modules (e.g. mint-approve-wallet.js) next to mint-approve.js
 * and break Discord slash registration.
 */
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
fs.rmSync(dist, { recursive: true, force: true });
console.log('[clean-dist] removed', dist);

import * as dotenv from 'dotenv';
dotenv.config();

import { startMintEngineHttp } from './server';

void startMintEngineHttp().catch(err => {
    console.error('[MintEngine] fatal', err);
    process.exit(1);
});

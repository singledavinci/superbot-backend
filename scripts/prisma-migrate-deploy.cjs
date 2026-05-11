/**
 * Load repo-root .env into process.env, then run `prisma migrate deploy` with cwd
 * packages/database so prisma.config.ts resolves DATABASE_URL (Prisma 7).
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
}
const dbDir = path.join(root, 'packages', 'database');
const r = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['prisma', 'migrate', 'deploy', '--schema=prisma/schema.prisma'],
    {
        cwd: dbDir,
        stdio: 'inherit',
        env: process.env,
        shell: process.platform === 'win32',
    },
);
process.exit(r.status === null ? 1 : r.status);

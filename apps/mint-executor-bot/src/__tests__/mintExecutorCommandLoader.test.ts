import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'path';
import { describe, it } from 'node:test';
import {
    EXPECTED_MINT_EXECUTOR_COMMAND_NAMES,
    isLegacyMintExecutorCommandFile,
    loadMintExecutorCommandsFromDir,
    mintExecutorSlashRegistrationBody,
} from '../lib/mintExecutorCommandLoader';

describe('mintExecutorCommandLoader', () => {
    const commandsDir = path.join(__dirname, '..', 'commands');

    it('finds all expected command source files on disk', () => {
        const names = fs
            .readdirSync(commandsDir)
            .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))
            .map(f => f.replace(/\.ts$/, ''))
            .sort();
        assert.deepEqual(names, [...EXPECTED_MINT_EXECUTOR_COMMAND_NAMES]);
    });

    it('marks legacy wallet rename stubs as skippable', () => {
        assert.equal(isLegacyMintExecutorCommandFile('mint-approve-wallet.ts'), true);
        assert.equal(isLegacyMintExecutorCommandFile('mint-approve-wallet.js'), true);
        assert.equal(isLegacyMintExecutorCommandFile('mint-revoke-wallet.js'), true);
        assert.equal(isLegacyMintExecutorCommandFile('mint-copy-wallet.ts'), false);
        assert.equal(isLegacyMintExecutorCommandFile('mint-approve.ts'), false);
    });

    it('loads every command with data + execute and matches expected count', async () => {
        const lines: string[] = [];
        const res = await loadMintExecutorCommandsFromDir({
            commandsDir,
            log: (l: string) => lines.push(l),
        });
        assert.equal(res.loadErrors.length, 0, res.loadErrors.map(e => `${e.file}: ${e.message}`).join('\n'));
        assert.equal(res.missingExports.length, 0);
        assert.equal(res.commands.size, EXPECTED_MINT_EXECUTOR_COMMAND_NAMES.length);
        for (const n of EXPECTED_MINT_EXECUTOR_COMMAND_NAMES) {
            assert.ok(res.commands.has(n), `missing command ${n}`);
            const m = res.commands.get(n)!;
            assert.ok(m.data?.name);
            assert.equal(typeof m.execute, 'function');
        }
        assert.ok(lines.some(l => l.includes('Command dir:')));
        assert.ok(lines.some(l => l.includes('Found ')));
        assert.ok(lines.some(l => l.includes('Loaded command: mint-status')));
        const body = mintExecutorSlashRegistrationBody(res.commands);
        assert.equal(body.length, EXPECTED_MINT_EXECUTOR_COMMAND_NAMES.length);
        const jsonNames = body
            .map(b => (b as { name?: string }).name)
            .filter(Boolean)
            .sort();
        assert.deepEqual(jsonNames, [...EXPECTED_MINT_EXECUTOR_COMMAND_NAMES]);
    });

    it('logs import failures or missing exports for invalid command files', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mint-ex-cmd-'));
        const bad = path.join(tmp, 'not-a-real-command.ts');
        fs.writeFileSync(bad, 'export const oops = 1;\n');
        const lines: string[] = [];
        const res = await loadMintExecutorCommandsFromDir({
            commandsDir: tmp,
            log: (l: string) => lines.push(l),
            expectedNames: [],
        });
        try {
            assert.ok(res.loadErrors.length >= 1 || res.missingExports.length >= 1);
            assert.ok(lines.some(l => l.includes('Failed to load') || l.includes('missing export')));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

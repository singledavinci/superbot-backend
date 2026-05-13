import fs from 'fs';
import { createRequire } from 'node:module';
import path from 'path';
import { pathToFileURL } from 'node:url';
import { Collection, type ChatInputCommandInteraction } from 'discord.js';

const requireModule = createRequire(__filename);

/** Slash command names the mint-executor bot is expected to register (canonical list). */
export const EXPECTED_MINT_EXECUTOR_COMMAND_NAMES = [
    'mint-approvals',
    'mint-approve',
    'mint-confirm-mainnet',
    'mint-copy-wallet',
    'mint-emergency-resume',
    'mint-emergency-stop',
    'mint-jobs',
    'mint-preflight',
    'mint-result',
    'mint-revoke',
    'mint-schedule',
    'mint-settings',
    'mint-status',
    'mint-stop',
].sort();

export type MintExecutorCommandModule = {
    data: { name: string; toJSON: () => unknown };
    execute: (i: ChatInputCommandInteraction) => Promise<void>;
    /** Which file produced this command (for duplicate diagnostics). */
    sourceFile: string;
};

export type LoadMintExecutorCommandsResult = {
    commands: Collection<string, MintExecutorCommandModule>;
    filesFound: string[];
    loadErrors: { file: string; message: string }[];
    missingExports: { file: string; missing: ('data' | 'execute')[] }[];
    duplicateNames: { name: string; keepFile: string; skippedFile: string }[];
};

function isCommandFile(name: string): boolean {
    if (name.endsWith('.d.ts')) return false;
    return name.endsWith('.js') || name.endsWith('.ts');
}

/** Renamed commands — stale `tsc` output can leave these next to canonical modules; never load them. */
const LEGACY_COMMAND_FILE = /^(mint-approve-wallet|mint-revoke-wallet)\.(ts|js)$/;

export function isLegacyMintExecutorCommandFile(file: string): boolean {
    return LEGACY_COMMAND_FILE.test(file);
}

/**
 * Dynamically loads mint-executor slash command modules from a directory.
 * Uses file:// URLs for `import()` so absolute paths work on Windows and Linux.
 */
export async function loadMintExecutorCommandsFromDir(args: {
    commandsDir: string;
    log: (line: string) => void;
    expectedNames?: readonly string[];
}): Promise<LoadMintExecutorCommandsResult> {
    const { commandsDir, log, expectedNames = EXPECTED_MINT_EXECUTOR_COMMAND_NAMES } = args;
    const commands = new Collection<string, MintExecutorCommandModule>();
    const loadErrors: { file: string; message: string }[] = [];
    const missingExports: { file: string; missing: ('data' | 'execute')[] }[] = [];
    const duplicateNames: { name: string; keepFile: string; skippedFile: string }[] = [];

    log(`[MintExecutorBot] Command dir: ${commandsDir}`);

    if (!fs.existsSync(commandsDir)) {
        log(`[MintExecutorBot] Command dir missing — cannot load slash commands`);
        return { commands, filesFound: [], loadErrors, missingExports, duplicateNames };
    }

    const filesFound = fs.readdirSync(commandsDir).filter(isCommandFile).sort();
    log(`[MintExecutorBot] Found ${filesFound.length} command file(s): ${filesFound.join(', ')}`);

    for (const file of filesFound) {
        if (isLegacyMintExecutorCommandFile(file)) {
            log(`[MintExecutorBot] Skipping legacy command file: ${file}`);
            continue;
        }
        const abs = path.join(commandsDir, file);
        let mod: Record<string, unknown>;
        try {
            if (file.endsWith('.js')) {
                mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
            } else {
                mod = requireModule(abs) as Record<string, unknown>;
            }
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            loadErrors.push({ file, message });
            log(`[MintExecutorBot] Failed to load command ${file}: ${message}`);
            continue;
        }

        const missing: ('data' | 'execute')[] = [];
        if (!mod.data) missing.push('data');
        if (typeof mod.execute !== 'function') missing.push('execute');
        if (missing.length) {
            missingExports.push({ file, missing });
            log(`[MintExecutorBot] Skipping ${file}: missing export(s): ${missing.join(', ')}`);
            continue;
        }

        const data = mod.data as { name: string; toJSON: () => unknown };
        const execute = mod.execute as (i: ChatInputCommandInteraction) => Promise<void>;
        const name = data?.name;
        if (!name || typeof name !== 'string') {
            missingExports.push({ file, missing: ['data'] });
            log(`[MintExecutorBot] Skipping ${file}: data.name is not a non-empty string`);
            continue;
        }

        const existing = commands.get(name);
        if (existing) {
            duplicateNames.push({ name, keepFile: existing.sourceFile, skippedFile: file });
            log(
                `[MintExecutorBot] Duplicate slash name "${name}": keeping ${existing.sourceFile}, skipping ${file}`,
            );
            continue;
        }

        commands.set(name, { data, execute, sourceFile: file });
        log(`[MintExecutorBot] Loaded command: ${name} (${file})`);
    }

    const loadedNames = [...commands.keys()].sort();
    log(`[MintExecutorBot] Loaded ${commands.size} command(s): ${loadedNames.join(', ')}`);

    const exp = [...expectedNames].sort();
    const missingNames = exp.filter(n => !commands.has(n));
    if (missingNames.length) {
        log(
            `[MintExecutorBot] Expected ${exp.length} commands; missing ${missingNames.length} name(s): ${missingNames.join(', ')}`,
        );
    }

    return { commands, filesFound, loadErrors, missingExports, duplicateNames };
}

/** REST body for Discord slash registration. */
export function mintExecutorSlashRegistrationBody(commands: Collection<string, MintExecutorCommandModule>): unknown[] {
    return [...commands.values()].map(x => x.data.toJSON());
}

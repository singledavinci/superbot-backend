import * as dotenv from 'dotenv';
import path from 'path';
import {
    Client,
    Collection,
    Events,
    GatewayIntentBits,
    REST,
    Routes,
} from 'discord.js';

import { isTrustMintAdmin, isGuildAdministrator } from './lib/mintAdmin';
import {
    EXPECTED_MINT_EXECUTOR_COMMAND_NAMES,
    loadMintExecutorCommandsFromDir,
    mintExecutorSlashRegistrationBody,
    type MintExecutorCommandModule,
} from './lib/mintExecutorCommandLoader';

dotenv.config();

export class MintExecutorBot {
    private client: Client;
    public commands: Collection<string, MintExecutorCommandModule>;

    constructor() {
        this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
        this.commands = new Collection();
    }

    private async loadCommands() {
        const dir = path.join(__dirname, 'commands');
        const res = await loadMintExecutorCommandsFromDir({
            commandsDir: dir,
            log: line => console.log(line),
        });
        this.commands = res.commands;
    }

    async start() {
        await this.loadCommands();
        const token = process.env.MINT_EXECUTOR_DISCORD_TOKEN || process.env.DISCORD_TOKEN;
        if (!token) {
            console.error(
                '[MintExecutorBot] Missing Discord token: set MINT_EXECUTOR_DISCORD_TOKEN (preferred) or DISCORD_TOKEN in .env',
            );
            process.exit(1);
        }
        if (!process.env.MINT_EXECUTOR_DISCORD_TOKEN?.trim() && process.env.DISCORD_TOKEN?.trim()) {
            console.warn(
                '[MintExecutorBot] Using DISCORD_TOKEN fallback — if this is the main SuperBot token, mint slash commands will register on the wrong application. Set MINT_EXECUTOR_DISCORD_TOKEN to the Supermint bot token only.',
            );
        }

        this.client.once(Events.ClientReady, async c => {
            console.log(`[MintExecutorBot] Ready as ${c.user.tag} (application id=${c.application?.id ?? '?'})`);
            const rest = new REST({ version: '10' }).setToken(token);
            const body = mintExecutorSlashRegistrationBody(this.commands);
            const names = [...this.commands.keys()].sort();
            console.log(`[MintExecutorBot] Loaded ${this.commands.size} command(s): ${names.join(', ')}`);

            const clientId = c.application?.id;
            if (!clientId || !body.length) {
                console.warn('[MintExecutorBot] Skipping slash registration (missing application id or empty command list)');
                return;
            }

            const expectedAppId = process.env.MINT_EXECUTOR_DISCORD_APPLICATION_ID?.trim();
            if (expectedAppId && expectedAppId !== clientId) {
                console.error(
                    `[MintExecutorBot] Refusing slash registration: token application id=${clientId} does not match MINT_EXECUTOR_DISCORD_APPLICATION_ID=${expectedAppId} (wrong bot token?)`,
                );
                return;
            }

            const registerSlash = (process.env.MINT_EXECUTOR_REGISTER_SLASH_COMMANDS ?? 'true').toLowerCase() !== 'false';
            if (!registerSlash) {
                console.log('[MintExecutorBot] Skipping slash registration (MINT_EXECUTOR_REGISTER_SLASH_COMMANDS=false)');
                return;
            }

            const guildId = process.env.MINT_EXECUTOR_GUILD_ID?.trim();
            /** When a guild is configured, skip global registration by default to avoid duplicate slash entries (guild + global). Set `MINT_EXECUTOR_REGISTER_GLOBAL_COMMANDS=true` to also push globals. */
            const registerGlobal =
                (process.env.MINT_EXECUTOR_REGISTER_GLOBAL_COMMANDS ?? '').toLowerCase() === 'true' || !guildId;

            if (this.commands.size !== EXPECTED_MINT_EXECUTOR_COMMAND_NAMES.length) {
                const missing = EXPECTED_MINT_EXECUTOR_COMMAND_NAMES.filter(n => !this.commands.has(n));
                console.warn(
                    `[MintExecutorBot] Expected ${EXPECTED_MINT_EXECUTOR_COMMAND_NAMES.length} commands but loaded ${this.commands.size}. Missing: ${missing.join(', ') || '(none)'}`,
                );
            }

            try {
                if (guildId) {
                    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
                    console.log(
                        `[MintExecutorBot] Registered ${body.length} guild command(s) for guild ${guildId} (visible in this server immediately)`,
                    );
                }
                if (registerGlobal) {
                    await rest.put(Routes.applicationCommands(clientId), { body });
                    console.log(
                        `[MintExecutorBot] Registered ${body.length} global command(s) — can take up to ~1 hour to show in every server`,
                    );
                } else {
                    console.log(
                        '[MintExecutorBot] Skipping global slash registration (MINT_EXECUTOR_GUILD_ID is set; guild commands are authoritative). Set MINT_EXECUTOR_REGISTER_GLOBAL_COMMANDS=true to also register globals.',
                    );
                }
            } catch (e) {
                console.error('[MintExecutorBot] Slash command registration failed:', e);
            }
        });

        this.client.on(Events.InteractionCreate, async interaction => {
            if (!interaction.isChatInputCommand()) return;
            const cmd = this.commands.get(interaction.commandName);
            if (!cmd) return;
            const name = interaction.commandName;
            if (
                [
                    'mint-emergency-stop',
                    'mint-emergency-resume',
                    'mint-approve',
                    'mint-revoke',
                    'mint-approvals',
                    'mint-confirm-mainnet',
                ].includes(name)
            ) {
                if (!isTrustMintAdmin(interaction)) {
                    await interaction.reply({
                        content: 'Administrator permission and mint admin allow-list (if configured) required.',
                        ephemeral: true,
                    });
                    return;
                }
            } else if (name === 'mint-settings') {
                if (!isGuildAdministrator(interaction)) {
                    await interaction.reply({ content: 'Administrator permission required.', ephemeral: true });
                    return;
                }
            }
            try {
                await cmd.execute(interaction);
            } catch (e) {
                console.error(e);
                const msg = e instanceof Error ? e.message : 'Error';
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({ content: msg, ephemeral: true });
                } else {
                    await interaction.reply({ content: msg, ephemeral: true });
                }
            }
        });

        await this.client.login(token);
    }
}

const bot = new MintExecutorBot();
void bot.start().catch(err => {
    console.error(err);
    process.exit(1);
});

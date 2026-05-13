import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import {
    Client,
    Collection,
    Events,
    GatewayIntentBits,
    REST,
    Routes,
    type ChatInputCommandInteraction,
} from 'discord.js';

import { isTrustMintAdmin, isGuildAdministrator } from './lib/mintAdmin';

dotenv.config();

export class MintExecutorBot {
    private client: Client;
    public commands: Collection<string, { data: { name: string; toJSON: () => unknown }; execute: (i: ChatInputCommandInteraction) => Promise<void> }>;

    constructor() {
        this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
        this.commands = new Collection();
    }

    private async loadCommands() {
        const dir = path.join(__dirname, 'commands');
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir).filter(f => (f.endsWith('.ts') || f.endsWith('.js')) && !f.endsWith('.d.ts'));
        for (const file of files) {
            const mod = await import(path.join(dir, file));
            if (mod.data && mod.execute) {
                this.commands.set(mod.data.name, mod);
            }
        }
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
            const cmds = [...this.commands.values()];
            const body = cmds.map(x => x.data.toJSON());
            const names = cmds.map(x => x.data.name).sort();
            console.log(`[MintExecutorBot] Loaded ${cmds.length} command(s): ${names.join(', ')}`);

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
            try {
                if (guildId) {
                    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
                    console.log(
                        `[MintExecutorBot] Registered ${body.length} guild command(s) for guild ${guildId} (visible in this server immediately)`,
                    );
                }
                await rest.put(Routes.applicationCommands(clientId), { body });
                console.log(
                    `[MintExecutorBot] Registered ${body.length} global command(s) — can take up to ~1 hour to show in every server`,
                );
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

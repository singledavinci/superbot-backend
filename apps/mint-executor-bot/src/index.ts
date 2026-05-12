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
            console.error('[MintExecutorBot] Missing MINT_EXECUTOR_DISCORD_TOKEN');
            process.exit(1);
        }

        this.client.once(Events.ClientReady, async c => {
            console.log(`[MintExecutorBot] Ready as ${c.user.tag}`);
            const rest = new REST({ version: '10' }).setToken(token);
            const body = [...this.commands.values()].map(x => x.data.toJSON());
            const clientId = c.application?.id;
            if (clientId && body.length) {
                await rest.put(Routes.applicationCommands(clientId), { body });
                console.log(`[MintExecutorBot] Registered ${body.length} global commands`);
            }
        });

        this.client.on(Events.InteractionCreate, async interaction => {
            if (!interaction.isChatInputCommand()) return;
            const cmd = this.commands.get(interaction.commandName);
            if (!cmd) return;
            const name = interaction.commandName;
            if (['mint-emergency-stop', 'mint-emergency-resume', 'mint-approve-wallet', 'mint-revoke-wallet'].includes(name)) {
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

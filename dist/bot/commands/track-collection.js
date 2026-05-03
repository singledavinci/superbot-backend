"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
exports.data = new discord_js_1.SlashCommandBuilder()
    .setName('track-collection')
    .setDescription('Track an NFT collection and route alerts to a specific channel.')
    .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.Administrator)
    .addStringOption(option => option.setName('contract')
    .setDescription('The 0x contract address of the collection')
    .setRequired(true))
    .addChannelOption(option => option.setName('channel')
    .setDescription('The channel to send the alerts to')
    .setRequired(true))
    .addRoleOption(option => option.setName('role')
    .setDescription('Optional role to ping for alerts')
    .setRequired(false));
async function execute(interaction) {
    const contract = interaction.options.get('contract')?.value;
    const channel = interaction.options.get('channel')?.channel;
    // Validate 0x address
    if (!contract.match(/^0x[a-fA-F0-9]{40}$/)) {
        return interaction.reply({ content: '❌ Invalid Ethereum contract address.', ephemeral: true });
    }
    // TODO: Save to PostgreSQL
    await interaction.reply({
        content: `✅ Successfully tracking collection \`${contract}\`. Alerts will be sent to <#${channel?.id}>.`
    });
}

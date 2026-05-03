"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
exports.data = new discord_js_1.SlashCommandBuilder()
    .setName('track-wallet')
    .setDescription('Track an NFT wallet and route alerts to a specific channel.')
    .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.Administrator)
    .addStringOption(option => option.setName('address')
    .setDescription('The 0x address of the wallet to track')
    .setRequired(true))
    .addChannelOption(option => option.setName('channel')
    .setDescription('The channel to send the alerts to')
    .setRequired(true))
    .addRoleOption(option => option.setName('role')
    .setDescription('Optional role to ping for alerts')
    .setRequired(false));
async function execute(interaction) {
    const address = interaction.options.get('address')?.value;
    const channel = interaction.options.get('channel')?.channel;
    // Validate 0x address
    if (!address.match(/^0x[a-fA-F0-9]{40}$/)) {
        return interaction.reply({ content: '❌ Invalid Ethereum address.', ephemeral: true });
    }
    // TODO: Save to PostgreSQL
    await interaction.reply({
        content: `✅ Successfully tracking wallet \`${address}\`. Alerts will be sent to <#${channel?.id}>.`
    });
}

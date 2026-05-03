"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
exports.data = new discord_js_1.SlashCommandBuilder()
    .setName('setup')
    .setDescription('Setup the AlphaBot alert channels in this server.')
    .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.Administrator);
async function execute(interaction) {
    // Basic implementation for MVP. In reality, this would likely show a modal or setup a database entry.
    await interaction.reply({
        content: '⚙️ AlphaBot Setup started! Please ensure I have permissions to create channels or use `/track-wallet` to map to existing channels.',
        ephemeral: true
    });
}

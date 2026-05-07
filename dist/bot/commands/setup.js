"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.data = void 0;
exports.execute = execute;
const discord_js_1 = require("discord.js");
const db_1 = require("../../db");
exports.data = new discord_js_1.SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure SuperBot alert channels for this server.')
    .setDefaultMemberPermissions(discord_js_1.PermissionFlagsBits.Administrator)
    .addChannelOption(opt => opt.setName('whale-channel')
    .setDescription('Channel for whale buy/sell alerts')
    .addChannelTypes(discord_js_1.ChannelType.GuildText)
    .setRequired(true))
    .addChannelOption(opt => opt.setName('mint-channel')
    .setDescription('Channel for Mint Radar alerts')
    .addChannelTypes(discord_js_1.ChannelType.GuildText)
    .setRequired(true));
async function execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const guildId = interaction.guildId;
    const whaleChannel = interaction.options.getChannel('whale-channel');
    const mintChannel = interaction.options.getChannel('mint-channel');
    try {
        const guildName = interaction.guild?.name || 'Discord Server';
        // Upsert guild record - Default to PRO tier to remove monetization boundaries
        await db_1.prisma.guild.upsert({
            where: { discordId: guildId },
            create: { discordId: guildId, name: guildName, planTier: 'PRO' },
            update: { name: guildName, planTier: 'PRO' },
        });
        const guild = await db_1.prisma.guild.findUnique({ where: { discordId: guildId } });
        if (!guild)
            throw new Error('Guild not found after upsert');
        // Create default alert rules
        await db_1.prisma.alertChannel.upsert({
            where: { discordChannelId: whaleChannel.id },
            create: { guildId: guild.id, discordChannelId: whaleChannel.id, name: whaleChannel.name || 'whale-alerts', alertType: 'WHALE_BUY' },
            update: { alertType: 'WHALE_BUY' },
        });
        await db_1.prisma.alertChannel.upsert({
            where: { discordChannelId: mintChannel.id },
            create: { guildId: guild.id, discordChannelId: mintChannel.id, name: mintChannel.name || 'mint-alerts', alertType: 'MINT_RADAR' },
            update: { alertType: 'MINT_RADAR' },
        });
        const embed = new discord_js_1.EmbedBuilder()
            .setColor('#00f0ff')
            .setTitle('✅ SuperBot Setup Complete')
            .setDescription('Your server has been configured successfully.')
            .addFields({ name: '🐳 Whale Alerts', value: `<#${whaleChannel.id}>`, inline: true }, { name: '🚀 Mint Radar', value: `<#${mintChannel.id}>`, inline: true })
            .setFooter({ text: 'Use /track-wallet and /track-collection to start monitoring.' })
            .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
    }
    catch (err) {
        console.error('[/setup] Error:', err);
        await interaction.editReply(`❌ Setup failed: ${err.message ?? 'Unknown error'}`);
    }
}

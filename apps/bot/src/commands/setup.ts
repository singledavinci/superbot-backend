import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, ChannelType, TextChannel, EmbedBuilder } from 'discord.js';
import { prisma } from '@superbot/database';

export const data = new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure SuperBot alert channels for this server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption(opt =>
        opt.setName('whale-channel')
            .setDescription('Channel for whale buy/sell alerts')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
    )
    .addChannelOption(opt =>
        opt.setName('mint-channel')
            .setDescription('Channel for Mint Radar alerts')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
    );

export async function execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId!;
    const whaleChannel = interaction.options.getChannel('whale-channel') as TextChannel;
    const mintChannel  = interaction.options.getChannel('mint-channel') as TextChannel;

    try {
        const guildName = interaction.guild?.name || 'Discord Server';

        // Upsert guild record - Default to PRO tier to remove monetization boundaries
        await prisma.guild.upsert({
            where:  { discordId: guildId },
            create: { discordId: guildId, name: guildName, planTier: 'PRO' },
            update: { name: guildName, planTier: 'PRO' },
        });

        const guild = await prisma.guild.findUnique({ where: { discordId: guildId } });
        if (!guild) throw new Error('Guild not found after upsert');

        // Create default alert rules
        await prisma.alertChannel.upsert({
            where: { guildId_alertType: { guildId: guild.id, alertType: 'WHALE_BUY' } },
            create: {
                guildId: guild.id,
                discordChannelId: whaleChannel.id,
                name: whaleChannel.name || 'whale-alerts',
                alertType: 'WHALE_BUY',
            },
            update: {
                discordChannelId: whaleChannel.id,
                name: whaleChannel.name || 'whale-alerts',
            },
        });

        await prisma.alertChannel.upsert({
            where: { guildId_alertType: { guildId: guild.id, alertType: 'MINT_RADAR' } },
            create: {
                guildId: guild.id,
                discordChannelId: mintChannel.id,
                name: mintChannel.name || 'mint-alerts',
                alertType: 'MINT_RADAR',
            },
            update: {
                discordChannelId: mintChannel.id,
                name: mintChannel.name || 'mint-alerts',
            },
        });

        const embed = new EmbedBuilder()
            .setColor('#00f0ff')
            .setTitle('✅ SuperBot Setup Complete')
            .setDescription('Your server has been configured successfully.')
            .addFields(
                { name: '🐳 Whale Alerts', value: `<#${whaleChannel.id}>`, inline: true },
                { name: '🚀 Mint Radar',   value: `<#${mintChannel.id}>`,  inline: true },
            )
            .setFooter({ text: 'Use /track-wallet and /track-collection to start monitoring.' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

    } catch (err: any) {
        console.error('[/setup] Error:', err);
        await interaction.editReply(`❌ Setup failed: ${err.message ?? 'Unknown error'}`);
    }
}

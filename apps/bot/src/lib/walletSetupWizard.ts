import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    type ButtonInteraction,
    type ModalSubmitInteraction,
} from 'discord.js';
import { prisma } from '@superbot/database';
import { BRAND_ACCENT } from './embedTheme';
import { EPHEMERAL_REPLY } from './interactionReply';
import { clearWalletDraft, getWalletDraft, setWalletDraft, type WalletSetupDraft } from './setupState';

const PREFIX = 'walletwiz';

export function buildWalletSetupPayload(draft: WalletSetupDraft) {
    const embed = new EmbedBuilder()
        .setColor(BRAND_ACCENT)
        .setTitle('Track whale wallet')
        .setDescription(
            `\`${draft.address}\`\n\n` +
                (draft.label ? `Label: **${draft.label}**\n\n` : '') +
                'Whale buys, sales, and mints route to your guild **whale-trades** channel (see `/alert-routes`).',
        )
        .setFooter({ text: 'Optional: add a label so alerts are easier to read' });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`${PREFIX}:btn:save`)
            .setLabel('Start tracking')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`${PREFIX}:btn:label`)
            .setLabel('Add label')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`${PREFIX}:btn:cancel`)
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger),
    );

    return { embeds: [embed], components: [row] };
}

export async function startWalletSetupWizard(
    guildDiscordId: string,
    userId: string,
    address: string,
): Promise<{ embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }> {
    const draft: WalletSetupDraft = { address: address.toLowerCase(), label: null };
    await setWalletDraft(guildDiscordId, userId, draft);
    return buildWalletSetupPayload(draft);
}

async function persistWallet(guildDiscordId: string, draft: WalletSetupDraft): Promise<string> {
    const guild = await prisma.guild.findUnique({ where: { discordId: guildDiscordId } });
    if (!guild) throw new Error('Server not set up. Run `/setup` first.');

    const whaleChannel = await prisma.alertChannel.findFirst({
        where: { guildId: guild.id, alertType: 'WHALE_BUY' },
    });
    const targetChannelId = whaleChannel?.discordChannelId;
    if (!targetChannelId) throw new Error('No whale channel configured. Run `/setup` first.');

    await prisma.trackedWallet.upsert({
        where: { address_guildId: { address: draft.address, guildId: guild.id } },
        create: {
            guildId: guild.id,
            address: draft.address,
            label: draft.label?.slice(0, 32) ?? null,
            alertChannelId: targetChannelId,
        },
        update: {
            label: draft.label?.slice(0, 32) ?? null,
            alertChannelId: targetChannelId,
        },
    });

    return targetChannelId;
}

export async function handleWalletWizardInteraction(
    interaction: ButtonInteraction | ModalSubmitInteraction,
): Promise<boolean> {
    if (!interaction.inGuild() || !interaction.guildId) return false;
    const guildId = interaction.guildId;
    const userId = interaction.user.id;

    if (interaction.isButton()) {
        if (interaction.customId === `${PREFIX}:btn:cancel`) {
            await clearWalletDraft(guildId, userId);
            await interaction.update({ content: 'Cancelled.', embeds: [], components: [] });
            return true;
        }

        if (interaction.customId === `${PREFIX}:btn:label`) {
            const draft = await getWalletDraft(guildId, userId);
            if (!draft) {
                await interaction.reply({
                    content: 'Setup expired — run `/track-wallet` again.',
                    ...EPHEMERAL_REPLY,
                });
                return true;
            }
            const modal = new ModalBuilder().setCustomId(`${PREFIX}:modal:label`).setTitle('Wallet label');
            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('label')
                        .setLabel('Display name (max 32 chars)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setMaxLength(32)
                        .setValue(draft.label ?? ''),
                ),
            );
            await interaction.showModal(modal);
            return true;
        }

        if (interaction.customId === `${PREFIX}:btn:save`) {
            const draft = await getWalletDraft(guildId, userId);
            if (!draft) {
                await interaction.reply({
                    content: 'Setup expired — run `/track-wallet` again.',
                    ...EPHEMERAL_REPLY,
                });
                return true;
            }
            await interaction.deferUpdate();
            try {
                const channelId = await persistWallet(guildId, draft);
                await clearWalletDraft(guildId, userId);
                const done = new EmbedBuilder()
                    .setColor(0x22c55e)
                    .setTitle('Wallet tracked')
                    .addFields(
                        { name: 'Address', value: `\`${draft.address}\``, inline: false },
                        { name: 'Label', value: draft.label ?? '—', inline: true },
                        { name: 'Alerts', value: `<#${channelId}>`, inline: true },
                    )
                    .setTimestamp();
                await interaction.editReply({ embeds: [done], components: [] });
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : 'Save failed';
                await interaction.editReply({ content: `Error: ${msg}`, embeds: [], components: [] });
            }
            return true;
        }
    }

    if (interaction.isModalSubmit() && interaction.customId === `${PREFIX}:modal:label`) {
        const draft = await getWalletDraft(guildId, userId);
        if (!draft) {
            await interaction.reply({ content: 'Setup expired — run `/track-wallet` again.', ephemeral: true });
            return true;
        }
        draft.label = interaction.fields.getTextInputValue('label').trim().slice(0, 32) || null;
        await setWalletDraft(guildId, userId, draft);
        await interaction.deferUpdate();
        await interaction.editReply(buildWalletSetupPayload(draft));
        return true;
    }

    return false;
}

export function isWalletWizardInteraction(customId: string): boolean {
    return customId.startsWith(PREFIX);
}

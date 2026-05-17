import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    type ButtonInteraction,
    type ModalSubmitInteraction,
    type StringSelectMenuInteraction,
} from 'discord.js';
import { buildGuideEmbed, GUIDE_PAGES } from './guideContent';
import { EPHEMERAL_REPLY } from './interactionReply';
import {
    handleCollectionWizardInteraction,
    isCollectionWizardInteraction,
} from './collectionSetupWizard';
import { handleWalletWizardInteraction, isWalletWizardInteraction } from './walletSetupWizard';

const GUIDE_PREFIX = 'guide:';

function guideNavRow(page: number): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`${GUIDE_PREFIX}prev:${page}`)
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 0),
        new ButtonBuilder()
            .setCustomId(`${GUIDE_PREFIX}next:${page}`)
            .setLabel('Next')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(page >= GUIDE_PAGES.length - 1),
    );
}

export async function handleGuideButton(interaction: ButtonInteraction): Promise<boolean> {
    if (!interaction.customId.startsWith(GUIDE_PREFIX)) return false;

    const parts = interaction.customId.split(':');
    const action = parts[1];
    const current = Number(parts[2]) || 0;
    let next = current;
    if (action === 'prev') next = Math.max(0, current - 1);
    if (action === 'next') next = Math.min(GUIDE_PAGES.length - 1, current + 1);

    await interaction.update({
        embeds: [buildGuideEmbed(next)],
        components: [guideNavRow(next)],
    });
    return true;
}

export function buildGuideReply(page = 0) {
    return {
        embeds: [buildGuideEmbed(page)],
        components: [guideNavRow(page)],
        ...EPHEMERAL_REPLY,
    };
}

export async function routeComponentInteraction(
    interaction: StringSelectMenuInteraction | ButtonInteraction | ModalSubmitInteraction,
): Promise<boolean> {
    const id = interaction.customId;

    if (interaction.isButton() && id.startsWith(GUIDE_PREFIX)) {
        return handleGuideButton(interaction);
    }

    if (isCollectionWizardInteraction(id)) {
        return handleCollectionWizardInteraction(interaction);
    }

    if (isWalletWizardInteraction(id) && (interaction.isButton() || interaction.isModalSubmit())) {
        return handleWalletWizardInteraction(interaction);
    }

    return false;
}

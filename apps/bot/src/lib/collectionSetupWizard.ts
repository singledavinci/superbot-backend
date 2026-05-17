import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle,
    type ButtonInteraction,
    type ModalSubmitInteraction,
    type StringSelectMenuInteraction,
} from 'discord.js';
import { prisma } from '@superbot/database';
import { redisConnection } from '@superbot/queue';
import {
    NFTMetadataClient,
    CollectionNameResolver,
    createRpcPoolFromEnv,
} from '@superbot/analytics';
import { BRAND_ACCENT } from './embedTheme';
import { EPHEMERAL_REPLY } from './interactionReply';
import {
    clearCollectionDraft,
    getCollectionDraft,
    setCollectionDraft,
    type CollectionSetupDraft,
} from './setupState';

const PREFIX = 'collwiz';

let resolver: CollectionNameResolver | null = null;
function getResolver(): CollectionNameResolver {
    if (!resolver) {
        const pool = createRpcPoolFromEnv();
        resolver = new CollectionNameResolver({
            redis: redisConnection,
            nftMetadata: new NFTMetadataClient({ redis: redisConnection }),
            rpcPool: pool && pool.httpsUrls.length > 0 ? pool : null,
        });
    }
    return resolver;
}

function pctLabel(v: number | null): string {
    if (v == null) return 'Off';
    return `${v}%`;
}

function parsePctChoice(raw: string): number | null {
    if (raw === 'off') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function selectRow(
    id: string,
    placeholder: string,
    current: number | null,
    options: { label: string; value: string }[],
): ActionRowBuilder<StringSelectMenuBuilder> {
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`${PREFIX}:sel:${id}`)
        .setPlaceholder(placeholder)
        .addOptions(
            options.map(o =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(o.label)
                    .setValue(o.value)
                    .setDefault(
                        o.value === 'off'
                            ? current == null
                            : String(current) === o.value,
                    ),
            ),
        );
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

const PCT_OPTIONS = [
    { label: 'Off', value: 'off' },
    { label: '5%', value: '5' },
    { label: '10%', value: '10' },
    { label: '15%', value: '15' },
    { label: '20%', value: '20' },
    { label: '25%', value: '25' },
];

export function buildCollectionSetupPayload(draft: CollectionSetupDraft, imageUrl?: string | null) {
    const embed = new EmbedBuilder()
        .setColor(BRAND_ACCENT)
        .setTitle(`Track collection — ${draft.name}`)
        .setDescription(
            `Contract \`${draft.contract.slice(0, 6)}…${draft.contract.slice(-4)}\`\n\n` +
                'Adjust thresholds below, then press **Save & track**.',
        )
        .addFields(
            { name: 'Floor drop alert', value: pctLabel(draft.floorDropPct), inline: true },
            { name: 'Floor rise alert', value: pctLabel(draft.floorRisePct), inline: true },
            { name: 'Hot mint', value: draft.hotMintEnabled ? 'On' : 'Off', inline: true },
            { name: 'Delist surges', value: draft.delistEnabled ? 'On' : 'Off', inline: true },
        )
        .setFooter({ text: 'Alerts route via SuperBot Alerts channels · /alert-routes' });

    if (imageUrl && /^https?:\/\//i.test(imageUrl)) embed.setThumbnail(imageUrl);

    const rows = [
        selectRow('floor_drop', 'Floor drop %', draft.floorDropPct, PCT_OPTIONS),
        selectRow('floor_rise', 'Floor rise %', draft.floorRisePct, PCT_OPTIONS),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`${PREFIX}:btn:toggle_hot`)
                .setLabel(`Hot mint: ${draft.hotMintEnabled ? 'On' : 'Off'}`)
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`${PREFIX}:btn:toggle_delist`)
                .setLabel(`Delist: ${draft.delistEnabled ? 'On' : 'Off'}`)
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`${PREFIX}:btn:save`)
                .setLabel('Save & track')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`${PREFIX}:btn:custom`)
                .setLabel('Custom %')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`${PREFIX}:btn:cancel`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger),
        ),
    ];

    return { embeds: [embed], components: rows };
}

export async function startCollectionSetupWizard(
    guildDiscordId: string,
    userId: string,
    contract: string,
    nameHint?: string | null,
): Promise<{
    embeds: EmbedBuilder[];
    components: (
        | ActionRowBuilder<StringSelectMenuBuilder>
        | ActionRowBuilder<ButtonBuilder>
    )[];
}> {
    const meta = await getResolver().resolve(contract, { trackedName: nameHint ?? undefined });
    const collectionMeta = await new NFTMetadataClient({ redis: redisConnection })
        .fetchCollection(contract)
        .catch(() => null);

    const draft: CollectionSetupDraft = {
        contract: contract.toLowerCase(),
        name: meta.name,
        floorDropPct: 10,
        floorRisePct: 10,
        hotMintEnabled: true,
        delistEnabled: true,
        imageUrl: collectionMeta?.imageUrl ?? null,
    };
    await setCollectionDraft(guildDiscordId, userId, draft);

    return buildCollectionSetupPayload(draft, draft.imageUrl);
}

export async function persistTrackedCollection(
    guildDiscordId: string,
    draft: CollectionSetupDraft,
): Promise<{ collectionName: string; channelId: string }> {
    const guild = await prisma.guild.findUnique({ where: { discordId: guildDiscordId } });
    if (!guild) throw new Error('Server not set up. Run `/setup` first.');

    const defaultChannel = await prisma.alertChannel.findFirst({ where: { guildId: guild.id } });
    const targetChannelId = defaultChannel?.discordChannelId;
    if (!targetChannelId) {
        throw new Error('No alert channels configured. Run `/setup` or provision SuperBot Alerts.');
    }

    await prisma.trackedCollection.upsert({
        where: {
            contractAddress_guildId: { contractAddress: draft.contract, guildId: guild.id },
        },
        create: {
            guildId: guild.id,
            contractAddress: draft.contract,
            name: draft.name.slice(0, 128),
            floorAlertPct: draft.floorDropPct,
            floorRiseAlertPct: draft.floorRisePct,
            hotMintEnabled: draft.hotMintEnabled,
            delistAlertEnabled: draft.delistEnabled,
            alertChannelId: targetChannelId,
        },
        update: {
            name: draft.name.slice(0, 128),
            floorAlertPct: draft.floorDropPct,
            floorRiseAlertPct: draft.floorRisePct,
            hotMintEnabled: draft.hotMintEnabled,
            delistAlertEnabled: draft.delistEnabled,
        },
    });

    return { collectionName: draft.name, channelId: targetChannelId };
}

export async function handleCollectionWizardInteraction(
    interaction: StringSelectMenuInteraction | ButtonInteraction | ModalSubmitInteraction,
): Promise<boolean> {
    if (!interaction.inGuild() || !interaction.guildId) return false;

    const guildId = interaction.guildId;
    const userId = interaction.user.id;

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith(`${PREFIX}:sel:`)) {
        await interaction.deferUpdate();
        const field = interaction.customId.slice(`${PREFIX}:sel:`.length);
        const draft = await getCollectionDraft(guildId, userId);
        if (!draft) {
            await interaction.editReply({
                content: 'Setup expired — run `/track-collection` again.',
                embeds: [],
                components: [],
            });
            return true;
        }
        const val = interaction.values[0];
        if (field === 'floor_drop') draft.floorDropPct = parsePctChoice(val);
        else if (field === 'floor_rise') draft.floorRisePct = parsePctChoice(val);
        await setCollectionDraft(guildId, userId, draft);
        await interaction.editReply(buildCollectionSetupPayload(draft, draft.imageUrl));
        return true;
    }

    if (interaction.isButton()) {
        if (interaction.customId === `${PREFIX}:btn:toggle_hot`) {
            await interaction.deferUpdate();
            const draft = await getCollectionDraft(guildId, userId);
            if (!draft) {
                await interaction.editReply({
                    content: 'Setup expired — run `/track-collection` again.',
                    embeds: [],
                    components: [],
                });
                return true;
            }
            draft.hotMintEnabled = !draft.hotMintEnabled;
            await setCollectionDraft(guildId, userId, draft);
            await interaction.editReply(buildCollectionSetupPayload(draft, draft.imageUrl));
            return true;
        }

        if (interaction.customId === `${PREFIX}:btn:toggle_delist`) {
            await interaction.deferUpdate();
            const draft = await getCollectionDraft(guildId, userId);
            if (!draft) {
                await interaction.editReply({
                    content: 'Setup expired — run `/track-collection` again.',
                    embeds: [],
                    components: [],
                });
                return true;
            }
            draft.delistEnabled = !draft.delistEnabled;
            await setCollectionDraft(guildId, userId, draft);
            await interaction.editReply(buildCollectionSetupPayload(draft, draft.imageUrl));
            return true;
        }

        if (interaction.customId === `${PREFIX}:btn:cancel`) {
            await interaction.deferUpdate();
            await clearCollectionDraft(guildId, userId);
            await interaction.editReply({
                content: 'Cancelled — collection was not tracked.',
                embeds: [],
                components: [],
            });
            return true;
        }

        if (interaction.customId === `${PREFIX}:btn:custom`) {
            const draft = await getCollectionDraft(guildId, userId);
            if (!draft) {
                await interaction.reply({
                    content: 'Setup expired — run `/track-collection` again.',
                    ...EPHEMERAL_REPLY,
                });
                return true;
            }
            const modal = new ModalBuilder()
                .setCustomId(`${PREFIX}:modal:custom`)
                .setTitle('Custom floor thresholds');
            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('floor_drop')
                        .setLabel('Floor drop % (blank = off)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                        .setPlaceholder('e.g. 12')
                        .setValue(draft.floorDropPct != null ? String(draft.floorDropPct) : ''),
                ),
                new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                        .setCustomId('floor_rise')
                        .setLabel('Floor rise % (blank = off)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                        .setPlaceholder('e.g. 8')
                        .setValue(draft.floorRisePct != null ? String(draft.floorRisePct) : ''),
                ),
            );
            await interaction.showModal(modal);
            return true;
        }

        if (interaction.customId === `${PREFIX}:btn:save`) {
            await interaction.deferUpdate();
            const draft = await getCollectionDraft(guildId, userId);
            if (!draft) {
                await interaction.editReply({
                    content: 'Setup expired — run `/track-collection` again.',
                    embeds: [],
                    components: [],
                });
                return true;
            }
            try {
                const { collectionName, channelId } = await persistTrackedCollection(guildId, draft);
                await clearCollectionDraft(guildId, userId);
                const done = new EmbedBuilder()
                    .setColor(0x22c55e)
                    .setTitle('Collection tracked')
                    .setDescription(`**${collectionName}** is now monitored in this server.`)
                    .addFields(
                        { name: 'Floor drop', value: pctLabel(draft.floorDropPct), inline: true },
                        { name: 'Floor rise', value: pctLabel(draft.floorRisePct), inline: true },
                        { name: 'Hot mint / Delist', value: `${draft.hotMintEnabled ? 'on' : 'off'} / ${draft.delistEnabled ? 'on' : 'off'}`, inline: true },
                        { name: 'Guild routes', value: `See <#${channelId}> and \`/alert-routes\``, inline: false },
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

    if (interaction.isModalSubmit() && interaction.customId === `${PREFIX}:modal:custom`) {
        const draft = await getCollectionDraft(guildId, userId);
        if (!draft) {
            await interaction.reply({
                content: 'Setup expired — run `/track-collection` again.',
                ...EPHEMERAL_REPLY,
            });
            return true;
        }
        const dropRaw = interaction.fields.getTextInputValue('floor_drop').trim();
        const riseRaw = interaction.fields.getTextInputValue('floor_rise').trim();
        draft.floorDropPct = dropRaw ? Math.max(0, Number(dropRaw)) || null : null;
        draft.floorRisePct = riseRaw ? Math.max(0, Number(riseRaw)) || null : null;
        await setCollectionDraft(guildId, userId, draft);
        await interaction.deferUpdate();
        await interaction.editReply(buildCollectionSetupPayload(draft, draft.imageUrl));
        return true;
    }

    if (interaction.customId.startsWith(PREFIX)) {
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: 'Unknown control — run `/track-collection` again for a fresh menu.',
                ...EPHEMERAL_REPLY,
            });
        }
        return true;
    }

    return false;
}

export function isCollectionWizardInteraction(customId: string): boolean {
    return customId.startsWith(PREFIX);
}

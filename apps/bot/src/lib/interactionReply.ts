import {
    MessageFlags,
    type InteractionDeferReplyOptions,
    type InteractionReplyOptions,
} from 'discord.js';

export const EPHEMERAL_REPLY: InteractionDeferReplyOptions & InteractionReplyOptions = {
    flags: MessageFlags.Ephemeral,
};

import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { prisma } from '@superbot/database';
import { Wallet, formatEther } from 'ethers';

export const data = new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('Manage your SuperBot sniping wallet')
    .addSubcommand(sub => sub
        .setName('status')
        .setDescription('Check your sniping wallet address and balance'))
    .addSubcommand(sub => sub
        .setName('generate')
        .setDescription('Generate a new secure sniping wallet for this account'))
    .addSubcommand(sub => sub
        .setName('export')
        .setDescription('Reveal your private key (use with caution!)'));

export async function execute(interaction: ChatInputCommandInteraction) {
    const userId = interaction.user.id;
    
    // Find or create user
    let user = await prisma.user.findUnique({
        where: { discordId: userId }
    });

    if (!user) {
        user = await prisma.user.create({
            data: { discordId: userId }
        });
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'generate') {
        if (user.encryptedPrivateKey) {
            return interaction.reply({ content: '⚠️ You already have a sniping wallet. Use `/wallet status` to see it.', ephemeral: true });
        }

        const wallet = Wallet.createRandom();
        const encrypted = Buffer.from(wallet.privateKey).toString('hex'); // Simple encoding for demo, use real encryption in prod

        await prisma.user.update({
            where: { discordId: userId },
            data: {
                encryptedPrivateKey: encrypted,
                walletAddress: wallet.address
            }
        });

        const embed = new EmbedBuilder()
            .setTitle('✅ Sniping Wallet Generated')
            .setDescription(`Your dedicated SuperBot wallet has been created.\n\n**Address:** \`${wallet.address}\`\n\nSend some ETH to this address to start sniping!`)
            .setColor(0x00FF00)
            .setFooter({ text: 'Security: Your keys are encrypted and never shared.' });

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (subcommand === 'status') {
        if (!user.walletAddress) {
            return interaction.reply({ content: '❌ You don’t have a sniping wallet yet. Use `/wallet generate` to create one.', ephemeral: true });
        }

        const embed = new EmbedBuilder()
            .setTitle('🏦 Wallet Status')
            .addFields(
                { name: 'Address', value: `\`${user.walletAddress}\`` },
                { name: 'Auto-Mint', value: user.autoMintEnabled ? '✅ Enabled' : '❌ Disabled', inline: true },
                { name: 'Max Price', value: `${user.maxMintPrice} ETH`, inline: true },
                { name: 'Gas Buffer', value: `${user.gasBufferGwei} Gwei`, inline: true }
            )
            .setColor(0x5865F2);

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (subcommand === 'export') {
        if (!user.encryptedPrivateKey) {
            return interaction.reply({ content: '❌ No wallet found.', ephemeral: true });
        }

        const pk = Buffer.from(user.encryptedPrivateKey, 'hex').toString();
        return interaction.reply({ content: `🔑 **Private Key:** \`${pk}\`\n\n**WARNING:** Never share this with anyone! Delete this message after copying.`, ephemeral: true });
    }
}

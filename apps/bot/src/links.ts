/**
 * Canonical Ethereum-mainnet outbound links for Discord embeds and buttons.
 * CatchMint collection URLs: /collection/ethereum/{contract}; see https://catchmint.xyz/
 */

function normContract(contract: string): string {
    return contract.trim().toLowerCase();
}

export const links = {
    opensea: {
        nft: (contract: string, tokenId: string) =>
            `https://opensea.io/assets/ethereum/${normContract(contract)}/${encodeURIComponent(tokenId)}`,
        collection: (slug: string) => `https://opensea.io/collection/${encodeURIComponent(slug)}`,
        /** Contract-scoped assets view when collection slug is unknown (Ethereum mainnet). */
        collectionByContract: (contract: string) =>
            `https://opensea.io/assets/ethereum/${normContract(contract)}`,
        wallet: (addressOrEns: string) => `https://opensea.io/${addressOrEns}`,
    },
    etherscan: {
        tx: (hash: string) => `https://etherscan.io/tx/${hash}`,
        wallet: (address: string) => `https://etherscan.io/address/${normContract(address)}`,
        /** Contract “Write Contract” tab (mint / interaction entry point). */
        writeContract: (contract: string) =>
            `https://etherscan.io/address/${normContract(contract)}#writeContract`,
        token: (contract: string) => `https://etherscan.io/token/${normContract(contract)}`,
        nft: (contract: string, tokenId: string) =>
            `https://etherscan.io/nft/${normContract(contract)}/${encodeURIComponent(tokenId)}`,
    },
    catchmint: {
        collection: (contract: string) =>
            `https://catchmint.xyz/collection/ethereum/${normContract(contract)}`,
    },
} as const;
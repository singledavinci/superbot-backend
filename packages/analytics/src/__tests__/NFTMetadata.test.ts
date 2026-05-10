import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import { NFTMetadataClient } from '../NFTMetadata';

/**
 * Unit-tests for NFTMetadataClient that verify the OpenSea -> Alchemy fallback
 * tree without making real network calls. We patch axios.get with a stub before
 * each test and restore it afterwards.
 *
 * Run with:
 *   node --test --require ts-node/register packages/analytics/src/__tests__/NFTMetadata.test.ts
 */

const ORIG_GET = axios.get;

type Stub = (url: string, config?: any) => Promise<any>;

function withStub<T>(stub: Stub, fn: () => Promise<T>): Promise<T> {
    (axios as any).get = stub;
    return fn().finally(() => {
        (axios as any).get = ORIG_GET;
    });
}

const CONTRACT = '0xed5af388653567af2f388e6224dc7c4b3241c544'; // azuki
const TOKEN_ID = '1234';

test('happy path: OpenSea returns full metadata', async () => {
    const client = new NFTMetadataClient({ openseaKey: 'opensea-test', alchemyKey: '' });
    await withStub(
        async (url: string) => {
            if (url.includes('/nfts/')) {
                return {
                    status: 200,
                    data: {
                        nft: {
                            identifier: TOKEN_ID,
                            collection: 'azuki',
                            name: 'Azuki #1234',
                            image_url: 'https://example.com/nft.png',
                            display_image_url: 'https://example.com/nft-display.png',
                            opensea_url: `https://opensea.io/assets/ethereum/${CONTRACT}/${TOKEN_ID}`,
                            rarity: { rank: 42 },
                            traits: [
                                { trait_type: 'Type', value: 'Human' },
                                { trait_type: 'Hair', value: 'Pink' },
                            ],
                        },
                    },
                };
            }
            throw new Error('unexpected url ' + url);
        },
        async () => {
            const m = await client.fetchNFT('ethereum', CONTRACT, TOKEN_ID);
            assert.ok(m);
            assert.equal(m!.name, 'Azuki #1234');
            assert.equal(m!.collectionSlug, 'azuki');
            assert.equal(m!.imageUrl, 'https://example.com/nft-display.png');
            assert.equal(m!.rarityRank, 42);
            assert.equal(m!.traits?.length, 2);
        },
    );
});

test('OpenSea 404 returns null and the next call hits cache (no second axios)', async () => {
    const client = new NFTMetadataClient({ openseaKey: 'opensea-test', alchemyKey: '' });

    let calls = 0;
    await withStub(
        async () => {
            calls += 1;
            return { status: 404, data: { detail: 'not found' } };
        },
        async () => {
            const first = await client.fetchNFT('ethereum', CONTRACT, '999999999');
            assert.equal(first, null);
            const second = await client.fetchNFT('ethereum', CONTRACT, '999999999');
            assert.equal(second, null);
            // Cache must absorb the second lookup so we still only saw 1 axios call.
            assert.equal(calls, 1, `expected exactly one OpenSea call, saw ${calls}`);
        },
    );
});

test('OpenSea 429 falls back to Alchemy', async () => {
    const client = new NFTMetadataClient({ openseaKey: 'opensea-test', alchemyKey: 'alchemy-test' });

    await withStub(
        async (url: string) => {
            if (url.includes('api.opensea.io')) {
                return { status: 429, data: { detail: 'rate limited' } };
            }
            if (url.includes('eth-mainnet.g.alchemy.com/nft/v3')) {
                return {
                    status: 200,
                    data: {
                        name: 'Azuki #1234',
                        image: { cachedUrl: 'https://cdn.alchemy.com/nft.png' },
                        raw: {
                            metadata: {
                                attributes: [{ trait_type: 'Type', value: 'Human' }],
                            },
                        },
                        contract: {
                            address: CONTRACT,
                            name: 'Azuki',
                            openSeaMetadata: {
                                collectionName: 'Azuki',
                                collectionSlug: 'azuki',
                            },
                        },
                    },
                };
            }
            throw new Error('unexpected url ' + url);
        },
        async () => {
            const m = await client.fetchNFT('ethereum', CONTRACT, TOKEN_ID);
            assert.ok(m, 'expected Alchemy fallback to populate metadata');
            assert.equal(m!.name, 'Azuki #1234');
            assert.equal(m!.collectionName, 'Azuki');
            assert.equal(m!.imageUrl, 'https://cdn.alchemy.com/nft.png');
            assert.equal(m!.traits?.length, 1);
        },
    );
});

test('both providers fail → returns null without throwing', async () => {
    const client = new NFTMetadataClient({ openseaKey: 'opensea-test', alchemyKey: 'alchemy-test' });

    await withStub(
        async () => {
            // Simulate full outage: both OpenSea and Alchemy are 503.
            return { status: 503, data: null };
        },
        async () => {
            const m = await client.fetchNFT('ethereum', CONTRACT, TOKEN_ID);
            assert.equal(m, null);
        },
    );
});

test('axios throw → returns null without throwing', async () => {
    const client = new NFTMetadataClient({ openseaKey: 'opensea-test', alchemyKey: 'alchemy-test' });
    await withStub(
        async () => {
            throw new Error('ECONNRESET');
        },
        async () => {
            const m = await client.fetchNFT('ethereum', CONTRACT, TOKEN_ID);
            assert.equal(m, null);
        },
    );
});

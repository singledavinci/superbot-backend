import type {
    ConfidenceLevel,
    ContextualExplanation,
    ContextualSignalLabel,
    IntelligenceReport,
    SignalGrade,
} from '@superbot/types';

/** Standard footer copy for market alerts (embeds also repeat in footer). */
export const MARKET_ALERT_DISCLAIMER =
    'Not financial advice. Signals are informational and may be incomplete or delayed.';

const INSUFF = 'Insufficient verified data.';

export function mapContextualSignalToGrade(signal: ContextualSignalLabel): SignalGrade {
    switch (signal) {
        case 'Strong bullish signal':
            return 'Strong Bullish';
        case 'Weak bullish signal':
            return 'Weak Bullish';
        case 'Neutral activity':
            return 'Neutral';
        case 'Weak bearish signal':
            return 'Weak Bearish';
        case 'Strong bearish signal':
            return 'Strong Bearish';
        case 'Suspicious activity':
            return 'Suspicious Activity';
        case 'High-risk momentum':
            return 'High Risk';
        case 'Insufficient data':
        default:
            return 'Neutral';
    }
}

function capEvidence(ev: string[], max = 4): string[] {
    return ev.slice(0, Math.min(max, ev.length));
}

function confidenceFromLimitations(limitations: string[], evidenceCount: number): ConfidenceLevel {
    if (limitations.length >= 3) return 'insufficient';
    if (limitations.length >= 1 || evidenceCount < 2) return 'medium';
    return 'high';
}

export interface WhaleContextMetrics {
    /** What the focal wallet did on-chain for intelligence logic. */
    behavior: 'buy' | 'sell' | 'mint';
    focalWalletTracked: boolean;
    priceEth: number | null;
    currency: string;
    marketplace: string;
    possibleWashTrading: boolean;
    /** Distinct wallets with qualifying whale alerts on this tracked collection within the Intel window */
    distinctWalletsInWindow: number;
    /** Raw qualifying whale events counted in window (never fabricated) */
    eventsInWindow: number;
    windowMinutes: number;
    floorEth: number | null;
    /** Percent change versus last cached floor_snapshot when both values exist */
    floorVsSnapshotPct: number | null;
    /** Listing pressure recently observed (mass-listing heuristic); unknown if false */
    listingSurgeSuspected?: boolean | null;
    /** Verified recent tracked sell-side activity count in window when available */
    recentTrackedSellsDistinctWallets?: number;
}

export function explainWhale(m: WhaleContextMetrics): ContextualExplanation {
    const limitations: string[] = [];
    if (!m.marketplace?.trim()) limitations.push('Marketplace name was not verified for this alert.');
    if (m.priceEth === null || m.priceEth <= 0) limitations.push(`${INSUFF} for comparable deal price.`);

    if (m.possibleWashTrading) {
        return {
            event: `On-chain NFT activity involved wallets that exchanged NFT transfers within the monitored window.`,
            context: `This pattern can sometimes reflect coordination; it requires manual verification.`,
            signal: 'Suspicious activity',
            evidence: capEvidence([
                'Best-effort graph: buyer and seller had an NFT movement between these wallets recently.',
                m.marketplace ? `Marketplace (if relayed): ${m.marketplace}.` : INSUFF,
            ]),
            risk: 'This flag is heuristic and cannot prove intent; treat it as a review prompt.',
            nextWatch:
                'Inspect the wallet pair and transfers on-chain; watch for repeats with the same counterparties.',
            confidence: limitations.length ? 'medium' : 'high',
            dataLimitations:
                limitations.length > 0
                    ? [...limitations]
                    : ['Wallet graph coverage is bounded to a short lookback window.'],
        };
    }

    const floorTrendUp =
        m.floorVsSnapshotPct !== null && !Number.isNaN(m.floorVsSnapshotPct)
            ? m.floorVsSnapshotPct > 0
            : null;
    const floorTrendDown = floorTrendUp === null ? null : !floorTrendUp && m.floorVsSnapshotPct! < 0;
    const hasFloorEvidence =
        typeof m.floorEth === 'number' && m.floorEth > 0 && m.floorVsSnapshotPct !== null;

    if (!hasFloorEvidence) limitations.push(`${INSUFF} for floor trend vs prior snapshot.`);

    if (m.behavior === 'buy') {
        const clustered = m.distinctWalletsInWindow >= 2 || m.eventsInWindow >= 2;
        let signal: ContextualSignalLabel = 'Insufficient data';
        if (clustered && m.focalWalletTracked && floorTrendUp === true && m.listingSurgeSuspected !== true)
            signal = 'Strong bullish signal';
        else if (clustered && m.focalWalletTracked && floorTrendUp !== false)
            signal = 'Weak bullish signal';
        else if (!clustered || m.distinctWalletsInWindow <= 1) signal = 'Weak bullish signal';
        else signal = 'Neutral activity';

        if (floorTrendDown === true && signal === 'Strong bullish signal') signal = 'Weak bullish signal';

        const evidenceRaw: string[] = [];
        evidenceRaw.push(
            `Tracked activity on this contract in ~${m.windowMinutes} min: distinct wallets=${m.distinctWalletsInWindow}, sampled events=${m.eventsInWindow}.`,
        );
        if (typeof m.priceEth === 'number' && m.priceEth > 0) {
            evidenceRaw.push(`Paid about ${m.priceEth.toFixed(4)} ${m.currency || 'ETH'}.`);
        }
        if (hasFloorEvidence) {
            evidenceRaw.push(
                `Listed floor snapshot moved about ${m.floorVsSnapshotPct! >= 0 ? '+' : ''}${m.floorVsSnapshotPct!.toFixed(2)}% vs cached prior.`,
            );
        }
        if (typeof m.floorEth === 'number' && m.floorEth > 0) {
            evidenceRaw.push(`Approximate referenced floor cache: ${m.floorEth.toFixed(4)} ETH.`);
        }

        const riskPieces: string[] = [
            'Isolated buys can coincide with repositioning unrelated to broader demand.',
        ];
        if (m.priceEth === null || m.priceEth <= 0) riskPieces.unshift('Deal price verification is incomplete.');
        if (!hasFloorEvidence) riskPieces.push('Floor linkage is thin or stale without a trustworthy snapshot.');
        riskPieces.push(m.listingSurgeSuspected ? 'Concurrent listing-pressure signals were hinted.' : 'Listing pressure was not inferred from detector state for this event.');

        return {
            event: `Monitored wallet acquired an NFT in this collection${m.marketplace ? ` via ${m.marketplace}` : ''}.`,
            context:
                clustered && floorTrendUp
                    ? `Coordinated buys from monitored wallets overlap with upward floor snapshots.`
                    : clustered
                      ? `Multiple monitored wallets showed related activity on this collection recently.`
                      : `Appears isolated among monitored wallets in the sampled window.`,
            signal,
            evidence: capEvidence(evidenceRaw),
            risk: riskPieces.join(' '),
            nextWatch:
                'Watch whether additional monitored wallets add exposure and compare floor/read listings snapshots over the next poll windows.',
            confidence: confidenceFromLimitations(limitations, evidenceRaw.length),
            dataLimitations: limitations,
        };
    }

    if (m.behavior === 'sell') {
        const sellsPRESSURE = (m.recentTrackedSellsDistinctWallets ?? 0) >= 2;
        const listingsUp = m.listingSurgeSuspected === true;
        const floorDown = floorTrendDown === true;
        let signal: ContextualSignalLabel = 'Neutral activity';
        if ((sellsPRESSURE && floorDown) || listingsUp) signal = 'Weak bearish signal';
        if (sellsPRESSURE && listingsUp && floorDown) signal = 'Strong bearish signal';
        const sellDistinct =
            typeof m.recentTrackedSellsDistinctWallets === 'number'
                ? `${m.recentTrackedSellsDistinctWallets}`
                : null;
        const evidenceRaw: string[] = [];
        if (typeof m.priceEth === 'number' && m.priceEth > 0) {
            evidenceRaw.push(`Printed price near ${m.priceEth.toFixed(4)} ${m.currency || 'ETH'}.`);
        }
        evidenceRaw.push(
            sellDistinct !== null
                ? `Tracked sell-alert fingerprint count (distinct wallets in window): ${sellDistinct}.`
                : INSUFF + ' for correlated tracked sell fingerprints.',
            sellsPRESSURE
                ? 'Multiple monitored sellers surfaced inside the sampled window.'
                : 'Tracked seller clustering was not established in this window snapshot.',
        );
        if (hasFloorEvidence) {
            evidenceRaw.push(
                `Listed floor snapshot change ${m.floorVsSnapshotPct! >= 0 ? '+' : ''}${m.floorVsSnapshotPct!.toFixed(2)}% vs cached prior.`,
            );
        }

        return {
            event: `Monitored wallet broadcast a sale transfer for this collection${m.marketplace ? ` on ${m.marketplace}` : ''}.`,
            context:
                sellsPRESSURE || listingsUp || floorDown
                    ? `Several exit or supply signals overlapped monitored tape.`
                    : `Single divestment absent corroborating pressure cues in detectors.`,
            signal,
            evidence: capEvidence(evidenceRaw.filter(Boolean)),
            risk: 'Selling can reflect treasury moves or profit-taking without implying structural demand swings.',
            nextWatch:
                'Monitor listing velocity, upcoming floor-impact follow-ups, and whether counterparties recapitalize inventory.',
            confidence: confidenceFromLimitations(limitations, evidenceRaw.length),
            dataLimitations: [...limitations],
        };
    }

    // WHALE_MINT
    let signal: ContextualSignalLabel =
        m.distinctWalletsInWindow >= 2 ? 'Strong bullish signal' : 'Neutral activity';

    const missingLiquiditySignals =
        !(typeof m.floorEth === 'number' && m.floorEth > 0) || m.floorVsSnapshotPct === null;
    if (missingLiquiditySignals) {
        limitations.push(`${INSUFF} for secondary-floor confirmation.`);
        if (signal === 'Strong bullish signal') signal = 'High-risk momentum';
    }

    const evidenceRaw: string[] = [
        `Tracked mint-interest windows show ${m.distinctWalletsInWindow} distinct wallets (${m.eventsInWindow} events) inside ~${m.windowMinutes} min.`,
    ];
    if (typeof m.floorEth === 'number' && m.floorEth > 0) {
        evidenceRaw.push(`Reference floor snapshot: ~${m.floorEth.toFixed(4)} ETH.`);
    }

    return {
        event: `Primary mint ingestion from monitored wallets.`,
        context:
            m.distinctWalletsInWindow >= 2
                ? `Synchronized monitored mint registrations often warrant protocol-level review.`
                : `Only one monitored wallet produced this mint spike in the sampled window.`,
        signal,
        evidence: capEvidence(evidenceRaw),
        risk: 'Early mint regimes carry execution and counterpart risks not visible on-chain.',
        nextWatch:
            'Track secondary-floor prints, cancellations, whether unique participants broaden, as well as contract verification sources.',
        confidence: confidenceFromLimitations(limitations, evidenceRaw.length),
        dataLimitations: [...limitations],
    };
}

export interface SweepIntelInput {
    itemCount: number;
    totalNative: number;
    currency: string;
    floorEth: number | null;
    floorVsSnapshotPct: number | null;
}

export function explainSweep(i: SweepIntelInput): ContextualExplanation {
    const limitations: string[] = [];
    if (!(i.itemCount > 0 && i.totalNative > 0)) limitations.push(`${INSUFF} linking volume to item counts.`);
    const floorImpactPositive =
        typeof i.floorVsSnapshotPct === 'number' ? i.floorVsSnapshotPct >= 0 : null;
    let signal: ContextualSignalLabel =
        i.itemCount >= 5 && i.totalNative >= 2 && floorImpactPositive === true
            ? 'Strong bullish signal'
            : 'Weak bullish signal';
    const evidence = capEvidence([
        `Sweep swept ${i.itemCount} NFTs for roughly ${i.totalNative.toFixed(4)} ${i.currency}.`,
        floorImpactPositive === null ? INSUFF : `Floor snapshot trend after context: ${i.floorVsSnapshotPct!.toFixed(2)}% vs prior snapshot.`,
        typeof i.floorEth === 'number' && i.floorEth > 0 ? `Reference floor snapshot ≈ ${i.floorEth.toFixed(4)} ETH.` : INSUFF,
    ]);
    return {
        event: `Single transaction aggregated ${i.itemCount} items from this collection.`,
        context: `Large basket fills can materially shift near-term quoting even if motives stay opaque.`,
        signal,
        evidence,
        risk: `One purchaser does not imply broad bids; inventories may move without sustained follow-through.`,
        nextWatch: `Compare floor-impact follow-ups, listing cadence from market polling, and next block-level transfers.`,
        confidence: confidenceFromLimitations(limitations, evidence.length),
        dataLimitations: limitations,
    };
}

export interface ClusterIntelInput {
    walletCount: number;
    windowMinutes: number;
    chain?: string;
}

export function explainClusterBuy(i: ClusterIntelInput): ContextualExplanation {
    const limitations: string[] = [];
    const strong = i.walletCount >= 4;
    return {
        event: `Tracked wallets signaled overlapping buys.`,
        context: strong
            ? `Multiple disjoint monitored wallets interacted within ${i.windowMinutes} minutes.`
            : `Breadth amongst monitored wallets is still limited within ${i.windowMinutes} minutes.`,
        signal: strong ? 'Strong bullish signal' : i.walletCount >= 2 ? 'Weak bullish signal' : 'Insufficient data',
        evidence: capEvidence([
            `${i.walletCount} distinct monitored wallets in ~${i.windowMinutes} minute window.`,
            i.chain ? `Chain: ${i.chain}.` : INSUFF + ' for supplemental chain cues.',
        ]),
        risk: `Unique-buyer breadth can still expand or fade as more traders route through different venues.`,
        nextWatch:
            `Track whether additional wallets join plus whether liquidity tightens materially on follow-up snapshots.`,
        confidence: strong ? 'high' : 'medium',
        dataLimitations: limitations,
    };
}

export interface MassListingIntelInput {
    listingCount: number;
    windowMs: number;
    floorBeforeEth: number | null;
}

export function explainMassListing(i: MassListingIntelInput): ContextualExplanation {
    const mins = Math.max(1, Math.round(i.windowMs / 60000));
    const evidence = capEvidence([
        `${i.listingCount} qualifying listings clustered within ~${mins} minutes.`,
        typeof i.floorBeforeEth === 'number' && i.floorBeforeEth > 0
            ? `Floor captured at detector window: ~${i.floorBeforeEth.toFixed(4)} ETH.`
            : INSUFF + ' linking live floor snapshots.',
        'Supply visibly returned to resale modules in bulk.',
    ]);
    return {
        event: `Listing surge breached configured detector thresholds.`,
        context: `Rapid resale supply often precedes thinner floors if clears do not absorb inventory.`,
        signal: i.listingCount >= 12 ? 'Weak bearish signal' : 'Neutral activity',
        evidence,
        risk: `Listings do not always convert into executed asks; cancellations can deflate apparent pressure.`,
        nextWatch:
            `Wait for delayed floor-impact follow-ups and reconcile bid depth with OpenSea cancellations feed.`,
        confidence: typeof i.floorBeforeEth === 'number' ? 'medium' : 'low',
        dataLimitations: [],
    };
}

export interface MassDelistIntelInput {
    delistCount: number;
    windowMs: number;
    floorBeforeEth: number | null;
}

export function explainMassDelist(i: MassDelistIntelInput): ContextualExplanation {
    const mins = Math.max(1, Math.round(i.windowMs / 60000));
    return {
        event: `${i.delistCount} cancellations landed inside the monitored resale window.`,
        context: `Meaningful delists can constrain visible supply temporarily as asks are revoked.`,
        signal: i.delistCount >= 10 ? 'Weak bullish signal' : 'Neutral activity',
        evidence: capEvidence([
            `${i.delistCount} delists during ~${mins} minutes.`,
            typeof i.floorBeforeEth === 'number' && i.floorBeforeEth > 0
                ? `Floor baseline during detection: ~${i.floorBeforeEth.toFixed(4)} ETH.`
                : INSUFF + ' for floor benchmarking.',
            'Interpretation hinges on motive (rotation vs relist pipelines).',
        ]),
        risk: `Strategic cancellations can distort perceived scarcity when inventory simply shifts venues.`,
        nextWatch:
            `Monitor sales prints, replacements listings, plus floor-impact snapshots to corroborate the move.`,
        confidence: typeof i.floorBeforeEth === 'number' ? 'medium' : 'low',
        dataLimitations: [],
    };
}

export interface FloorImpactIntelInput {
    originalAlertType: 'MASS_LISTING' | 'MASS_DELIST';
    floorBefore: number | null;
    floorAfter: number | null;
    pctChange: number | null;
}

export function explainFloorImpactFollowup(i: FloorImpactIntelInput): ContextualExplanation {
    const limitations: string[] = [];
    const hasBeforeAfter =
        typeof i.floorBefore === 'number' &&
        typeof i.floorAfter === 'number' &&
        i.floorBefore > 0 &&
        i.floorAfter > 0;
    const pctKnown = typeof i.pctChange === 'number' && !Number.isNaN(i.pctChange);

    let signal: ContextualSignalLabel = 'Insufficient data';
    if (hasBeforeAfter && pctKnown) {
        if (i.originalAlertType === 'MASS_DELIST')
            signal = i.pctChange! > 0 ? 'Strong bullish signal' : i.pctChange! < -0.5 ? 'Weak bearish signal' : 'Neutral activity';
        else
            signal = i.pctChange! < -0.5 ? 'Weak bearish signal' : i.pctChange! > 0.5 ? 'Weak bullish signal' : 'Neutral activity';
    } else limitations.push(`${INSUFF} for complete floor before / after linkage.`);

    const evidenceArr: string[] = [];
    if (hasBeforeAfter) {
        evidenceArr.push(`Floor moved from ~${i.floorBefore!.toFixed(4)} to ~${i.floorAfter!.toFixed(4)} ETH.`);
    } else evidenceArr.push(INSUFF);

    evidenceArr.push(
        pctKnown
            ? `Observed Δ ≈ ${i.pctChange! >= 0 ? '+' : ''}${i.pctChange!.toFixed(2)}%.`
            : `${INSUFF} for percentage move.`,
        i.originalAlertType === 'MASS_LISTING'
            ? `Relates to preceding listing surge.`
            : `Relates to preceding delist surge.`,
    );

    return {
        event: `Post-waitfloor observation (${i.originalAlertType === 'MASS_LISTING' ? 'listing' : 'delist'} context).`,
        context: pctKnown ? `Measures whether headline supply anomaly translated into observable floor deltas.` : INSUFF,
        signal,
        evidence: capEvidence(evidenceArr),
        risk:
            'Very short horizons can exaggerate thin-order-book prints or venue lag; corroborate with additional snapshots.',
        nextWatch:
            `Align with refreshed listing counts, cancellations, plus volume-weight prints on the resale venue.`,
        confidence: pctKnown ? 'medium' : 'insufficient',
        dataLimitations: limitations,
    };
}

export interface HotMintIntelInput {
    uniqueMinters: number;
    totalMints: number;
    windowMinutes: number;
    velocityPerMin: number;
    floorEth: number | null;
    minUniqueConfigured: number;
    minTotalConfigured: number;
}

export function explainHotMint(i: HotMintIntelInput): ContextualExplanation {
    const limitations: string[] = [];
    const meetsBurst =
        i.uniqueMinters >= i.minUniqueConfigured && i.totalMints >= i.minTotalConfigured;
    const hasFloorRef = typeof i.floorEth === 'number' && i.floorEth > 0;
    if (!hasFloorRef) limitations.push(`${INSUFF} for secondary floor corroboration in this detector window.`);

    let signal: ContextualSignalLabel = meetsBurst ? 'Strong bullish signal' : 'Neutral activity';
    if (meetsBurst && !hasFloorRef) signal = 'High-risk momentum';

    const evidence = capEvidence([
        `${i.uniqueMinters} distinct minters minted ${i.totalMints} NFTs inside ~${i.windowMinutes} minutes.`,
        `Velocity ≈ ${i.velocityPerMin.toFixed(2)} mints / minute (window-normalized).`,
        hasFloorRef
            ? `Reference floor snapshot tied to enrichment: ~${i.floorEth!.toFixed(4)} ETH.`
            : INSUFF + ' for reference floor linkage.',
        `Detector thresholds referenced: ≥${i.minUniqueConfigured} wallets & ≥${i.minTotalConfigured} mints.`,
    ]);

    return {
        event: `Hot mint detector breached configured velocity / breadth gates.`,
        context: meetsBurst ? `Breadth × speed simultaneously cleared guardrails.` : `Activity remains below simultaneous gates.`,
        signal,
        evidence,
        risk:
            `Fast issuance without visible secondary liquidity cues can disguise protocol or execution risks — verify bytecode and royalties independently.`,
        nextWatch:
            `Watch resale floor stabilization, cancellations, bidder breadth after trading opens, plus repeated buyer clusters.`,
        confidence: meetsBurst && hasFloorRef ? 'high' : meetsBurst ? 'low' : 'medium',
        dataLimitations: limitations,
    };
}

export interface FloorMoveIntelInput {
    direction: 'rise' | 'drop';
    floorPrice: number;
    prevFloor: number;
    pctChange: number;
    currency: string;
    /** Verified listing / sales deltas are attached for this recap */
    hasCorroboration: boolean;
}

export function explainFloorMovement(i: FloorMoveIntelInput): ContextualExplanation {
    const limitations: string[] = [
        ...(i.hasCorroboration ? [] : [`No verified simultaneous sales-volume or listings delta was bundled with this automation snapshot.`]),
    ];

    let signal: ContextualSignalLabel = i.hasCorroboration
        ? i.direction === 'rise'
            ? 'Strong bullish signal'
            : 'Strong bearish signal'
        : i.direction === 'rise'
          ? Math.abs(i.pctChange) >= 5 && i.floorPrice > 0
              ? 'Weak bullish signal'
              : 'Insufficient data'
          : Math.abs(i.pctChange) >= 5 && i.floorPrice > 0
            ? 'Weak bearish signal'
            : 'Insufficient data';

    if (i.direction === 'rise' && !i.hasCorroboration && signal === 'Strong bullish signal')
        signal = 'Weak bullish signal';

    const evidence = capEvidence([
        `${i.direction === 'rise' ? 'Floor climbed' : 'Floor declined'} ~${Math.abs(i.pctChange).toFixed(2)}% between cached ticks.`,
        `Prior reference: ${i.prevFloor.toFixed(4)} ${i.currency}; now ~${i.floorPrice.toFixed(4)} ${i.currency}.`,
        i.hasCorroboration ? 'Supporting venue statistics were flagged as present for this emission.' : INSUFF + ' tying move to aggregated sale counts.',
        'Thin floors can amplify percentage swings from single outliers.',
    ]);

    return {
        event: `Floor alert threshold tripped (${i.direction === 'rise' ? 'rise' : 'drop'} policy).`,
        context:
            i.direction === 'rise'
                ? `Rising snapshots can coincide with thinning asks or uneven depth.`
                : `Negative shifts may reflect widening asks absent matching bid support.`,
        signal,
        evidence,
        risk:
            i.direction === 'rise'
                ? `Without broader depth metrics, uplift may be fleeting if listings return quickly.`
                : `A single distressed listing can overstated directional labels when quoting is sparse.`,
        nextWatch:
            `Compare cancellations, swept lots, whale prints, plus next scheduled floor-impact follow-ups.`,
        confidence: i.hasCorroboration ? 'medium' : 'low',
        dataLimitations: limitations,
    };
}

export function contextualToIntelligenceReport(
    cx: ContextualExplanation,
    aiNarrative?: string | null,
): IntelligenceReport {
    return {
        grade: mapContextualSignalToGrade(cx.signal),
        context: cx.context,
        risk: cx.risk,
        nextWatch: cx.nextWatch,
        contextual: cx,
        aiNarrative: aiNarrative ?? undefined,
    };
}

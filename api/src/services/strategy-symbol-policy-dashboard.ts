import type { Firestore } from 'firebase-admin/firestore'

import { getFirestoreClient } from '../firestore.js'
import type {
    StrategySymbolPolicy,
} from '../types/strategy-symbol-policy.js'
import type {
    StrategySymbolPosition,
} from '../types/strategy-symbol-position.js'
import type {
    StrategySymbolPolicyDashboardEntry,
    StrategySymbolPolicyDashboardResponse,
    StrategySymbolPolicyLedgerHealth,
} from '../types/strategy-symbol-policy-dashboard.js'
import {
    createStrategySymbolPolicyId,
    deserializeStrategySymbolPolicy,
    isValidStrategyId,
} from './strategy-symbol-policies.js'
import { deserializeStrategySymbolPosition } from './strategy-symbol-positions.js'
import { parseSymbolId } from './tradable-symbols.js'

const POLICIES_COLLECTION = 'strategy_symbol_policies'
const POSITIONS_COLLECTION = 'strategy_symbol_positions'

type SnapshotLike = {
    id: string
    data: () => unknown
}

type DashboardIdentity = {
    strategyId: string
    symbolId: string
}

type LedgerBucket = {
    id: string
    identity?: DashboardIdentity
    policy?: StrategySymbolPolicy
    position?: StrategySymbolPosition
    policyIssue?: string
    positionIssue?: string
}

export type ListStrategySymbolPolicyDashboardFn = () => Promise<StrategySymbolPolicyDashboardResponse>

export type StrategySymbolPolicyDashboardServiceOptions = {
    db?: Firestore
    now?: () => number
}

const getSnapshotId = (snapshot: SnapshotLike): string => snapshot.id

const getSnapshotData = (snapshot: SnapshotLike): unknown => snapshot.data()

/**
 * A document ID is the only trustworthy identity when a stored document is
 * malformed.  Derive fields from it only after validating the complete
 * strategy:symbol shape; never copy identity fields from malformed data.
 */
const parseDashboardIdentity = (documentId: string): DashboardIdentity | undefined => {
    const separator = documentId.indexOf(':')
    if (separator <= 0 || separator === documentId.length - 1) return undefined

    const strategyId = documentId.slice(0, separator)
    const symbolId = documentId.slice(separator + 1)
    if (!isValidStrategyId(strategyId) || parseSymbolId(symbolId) === null) return undefined

    try {
        if (createStrategySymbolPolicyId(strategyId, symbolId) !== documentId) return undefined
    } catch {
        return undefined
    }

    return { strategyId, symbolId }
}

const invalidReason = (error: unknown, fallback: string): string => (
    error instanceof Error && error.message.length > 0 ? error.message : fallback
)

const bucketFor = (buckets: Map<string, LedgerBucket>, documentId: string): LedgerBucket => {
    const existing = buckets.get(documentId)
    if (existing) return existing

    const bucket: LedgerBucket = {
        id: documentId,
        identity: parseDashboardIdentity(documentId),
    }
    buckets.set(documentId, bucket)
    return bucket
}

const parsePolicy = (bucket: LedgerBucket, snapshot: SnapshotLike): void => {
    if (!bucket.identity) {
        bucket.policyIssue = 'policy document ID is invalid'
        return
    }

    try {
        bucket.policy = deserializeStrategySymbolPolicy(
            getSnapshotData(snapshot),
            bucket.id,
            bucket.identity.strategyId,
            bucket.identity.symbolId,
        )
    } catch (error) {
        bucket.policyIssue = invalidReason(error, 'policy document is invalid')
    }
}

const parsePosition = (bucket: LedgerBucket, snapshot: SnapshotLike): void => {
    try {
        bucket.position = deserializeStrategySymbolPosition(getSnapshotData(snapshot), bucket.id)
    } catch (error) {
        bucket.positionIssue = invalidReason(error, 'position document is invalid')
    }
}

const healthFor = (bucket: LedgerBucket): StrategySymbolPolicyLedgerHealth => {
    if (bucket.policyIssue) return 'INVALID_POLICY'
    if (bucket.positionIssue) return 'INVALID_POSITION'
    if (bucket.policy && !bucket.position) return 'MISSING_POSITION'
    if (!bucket.policy && bucket.position) return 'ORPHAN_POSITION'
    if (bucket.policy && bucket.position && bucket.policy.version !== bucket.position.policy_version) {
        return 'VERSION_MISMATCH'
    }
    // A bucket always originates from at least one document.  If an invalid
    // document ID made both parsers impossible, classify it as invalid rather
    // than silently presenting it as a healthy empty ledger.
    if (!bucket.policy && !bucket.position) {
        return bucket.policyIssue ? 'INVALID_POLICY' : 'INVALID_POSITION'
    }
    return 'READY'
}

const toEntry = (bucket: LedgerBucket): StrategySymbolPolicyDashboardEntry => {
    const identity = bucket.identity
    const health = healthFor(bucket)
    return {
        id: bucket.id,
        ...(identity === undefined ? { document_id: bucket.id } : {
            strategy_id: identity.strategyId,
            symbol_id: identity.symbolId,
        }),
        ...(bucket.policy === undefined ? {} : { policy: bucket.policy }),
        ...(bucket.position === undefined ? {} : { position: bucket.position }),
        ledger_health: health,
        ...(bucket.policyIssue !== undefined
            ? { issue: bucket.policyIssue }
            : bucket.positionIssue !== undefined
                ? { issue: bucket.positionIssue }
                : {}),
    }
}

const createService = (
    options: StrategySymbolPolicyDashboardServiceOptions,
): ListStrategySymbolPolicyDashboardFn => {
    const db = options.db ?? getFirestoreClient()
    const now = options.now ?? (() => Date.now())

    return async () => {
        // The current operational scale intentionally uses complete reads. No
        // ordering/index is required because entries are sorted in memory by
        // their stable document ID.
        const [policiesSnapshot, positionsSnapshot] = await Promise.all([
            db.collection(POLICIES_COLLECTION).get(),
            db.collection(POSITIONS_COLLECTION).get(),
        ])
        const buckets = new Map<string, LedgerBucket>()

        for (const rawSnapshot of policiesSnapshot.docs as unknown as SnapshotLike[]) {
            const snapshot = rawSnapshot
            const bucket = bucketFor(buckets, getSnapshotId(snapshot))
            parsePolicy(bucket, snapshot)
        }
        for (const rawSnapshot of positionsSnapshot.docs as unknown as SnapshotLike[]) {
            const snapshot = rawSnapshot
            const bucket = bucketFor(buckets, getSnapshotId(snapshot))
            parsePosition(bucket, snapshot)
        }

        const entries = [...buckets.values()]
            .sort((left, right) => left.id.localeCompare(right.id))
            .map(toEntry)

        return {
            entries,
            updated_at: now(),
        }
    }
}

export const createListStrategySymbolPolicyDashboardFn = (
    options: StrategySymbolPolicyDashboardServiceOptions = {},
): ListStrategySymbolPolicyDashboardFn => createService(options)

export const createDefaultListStrategySymbolPolicyDashboardFn = (): ListStrategySymbolPolicyDashboardFn => (
    createListStrategySymbolPolicyDashboardFn({ db: getFirestoreClient() })
)

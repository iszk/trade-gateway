import type { StrategySymbolPolicy } from './strategy-symbol-policy.js'
import type { StrategySymbolPosition } from './strategy-symbol-position.js'

/**
 * The health of the policy/virtual-position ledger for one document ID.
 *
 * This is deliberately separate from StrategySymbolPositionStatus.  A
 * position can be in MANUAL_REVIEW while its document is structurally valid
 * and has the same policy version, whereas a missing or malformed document is
 * a ledger integrity problem.
 */
export type StrategySymbolPolicyLedgerHealth =
    | 'READY'
    | 'MISSING_POSITION'
    | 'ORPHAN_POSITION'
    | 'VERSION_MISMATCH'
    | 'INVALID_POLICY'
    | 'INVALID_POSITION'

export type StrategySymbolPolicyDashboardEntry = {
    /** The shared policy/position document ID when it can be determined. */
    id: string
    /** Present for malformed document IDs where strategy_id cannot be trusted. */
    document_id?: string
    /** Derived from the document ID, never copied from an invalid document. */
    strategy_id?: string
    /** Derived from the document ID, never copied from an invalid document. */
    symbol_id?: string
    policy?: StrategySymbolPolicy
    position?: StrategySymbolPosition
    ledger_health: StrategySymbolPolicyLedgerHealth
    /** Safe, operator-facing reason for an invalid ledger document. */
    issue?: string
}

export type StrategySymbolPolicyDashboardResponse = {
    entries: StrategySymbolPolicyDashboardEntry[]
    updated_at: number
}

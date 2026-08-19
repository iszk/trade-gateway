import type { OrderSide } from '../types/order.js'
import type { OrderConstraints } from '../types/tradable-symbol.js'
import type { StrategySymbolPolicy } from '../types/strategy-symbol-policy.js'
import {
    addQuantities,
    compareQuantities,
    floorToQuantityStep,
    isFiniteQuantity,
    isQuantityStepAligned,
    isUsableQuantityStep,
    multiplyQuantity,
    subtractQuantities,
} from './quantity.js'

export type CalculateOrderSizeInput = {
    policy: StrategySymbolPolicy
    constraints: OrderConstraints
    confirmedPosition: number
    pendingDelta: number
    side: OrderSide
    inputSize?: number
}

export type SizingConstraint =
    | 'MAX_POSITION'
    | 'NO_FLIP'
    | 'MAX_ORDER_SIZE'
    | 'QUANTITY_STEP'
    | 'MIN_ORDER_SIZE'

export type SizingDecisionDetails = {
    effectivePosition?: number
    positionAfter?: number
    candidateSize?: number
    rawSize?: number
    constrainedSize?: number
    roundedSize?: number
    effectiveSize?: number
    quantityStep?: number
    minOrderSize?: number
    maxOrderSize?: number
    maxAbsPosition?: number
    noFlip?: boolean
    appliedConstraints: SizingConstraint[]
    invalidField?: string
}

export type SizingDecision =
    | {
        kind: 'DISPATCH'
        effectiveSize: number
        reason: 'CALCULATED'
        details: SizingDecisionDetails
    }
    | {
        kind: 'SUPPRESS'
        reason: 'POLICY_DISABLED' | 'MAX_POSITION' | 'NO_FLIP' | 'BELOW_MIN_ORDER_SIZE'
        details: SizingDecisionDetails
    }
    | {
        kind: 'REJECT'
        reason: 'SIZE_REQUIRED' | 'INVALID_SIZE' | 'INVALID_SIZE_INCREMENT' | 'INVALID_CALCULATION_INPUT'
        details: SizingDecisionDetails
    }

type RecordValue = Record<string, unknown>

const isRecord = (value: unknown): value is RecordValue =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const isPositiveFinite = (value: unknown): value is number =>
    isFiniteQuantity(value) && value > 0

const invalidDetails = (field?: string, partial: Partial<SizingDecisionDetails> = {}): SizingDecisionDetails => ({
    appliedConstraints: [],
    ...partial,
    ...(field === undefined ? {} : { invalidField: field }),
})

const rejectCalculationInput = (
    field: string,
    partial: Partial<SizingDecisionDetails> = {},
): SizingDecision => ({
    kind: 'REJECT',
    reason: 'INVALID_CALCULATION_INPUT',
    details: invalidDetails(field, partial),
})

const suppress = (
    reason: 'POLICY_DISABLED' | 'MAX_POSITION' | 'NO_FLIP' | 'BELOW_MIN_ORDER_SIZE',
    details: SizingDecisionDetails,
): SizingDecision => ({
    kind: 'SUPPRESS',
    reason,
    details,
})

const compareOrReject = (
    left: number,
    right: number,
    step: number,
    details: SizingDecisionDetails,
    field: string,
): QuantityComparisonResult => {
    const comparison = compareQuantities(left, right, step)
    return comparison === null
        ? { decision: rejectCalculationInput(field, details) }
        : { comparison }
}

type QuantityComparisonResult =
    | { comparison: -1 | 0 | 1 }
    | { decision: SizingDecision }

const signedSize = (size: number, side: OrderSide): number | null =>
    multiplyQuantity(size, side === 'BUY' ? 1 : -1)

const withCommonDetails = (
    effectivePosition: number,
    constraints: OrderConstraints,
    policy: RecordValue,
): SizingDecisionDetails => ({
    effectivePosition,
    quantityStep: constraints.quantity_step,
    minOrderSize: constraints.min_order_size,
    ...(constraints.max_order_size === undefined ? {} : { maxOrderSize: constraints.max_order_size }),
    maxAbsPosition: policy.max_abs_position as number,
    noFlip: policy.no_flip as boolean,
    appliedConstraints: [],
})

const clampByLimit = (
    current: number,
    limit: number,
    details: SizingDecisionDetails,
    field: string,
): { value: number; limited: boolean } | { decision: SizingDecision } => {
    if (!isFiniteQuantity(current) || !isFiniteQuantity(limit)) {
        return { decision: rejectCalculationInput(field, details) }
    }
    // 安全上限の clamp では step 整合の許容差を使わない。
    // current が limit を数値上僅かでも超えていれば、必ず limit 側を採用する。
    return current > limit
        ? { value: limit, limited: true }
        : { value: current, limited: false }
}

const buildPositionAfter = (
    position: number,
    size: number,
    side: OrderSide,
): number | null => {
    const signed = signedSize(size, side)
    return signed === null ? null : addQuantities(position, signed)
}

/**
 * policy、symbol 制約、仮想 position から発注可能な数量を決定する純粋関数。
 * 入力契約違反は例外ではなく REJECT として返す。
 */
export const calculateOrderSize = (input: CalculateOrderSizeInput): SizingDecision => {
    try {
        const inputRecord = isRecord(input) ? input : null
        if (inputRecord === null) return rejectCalculationInput('input')

        const constraintsValue = inputRecord.constraints
        if (!isRecord(constraintsValue)) return rejectCalculationInput('constraints')
        const constraints = constraintsValue
        const quantityStep = constraints.quantity_step
        const minOrderSize = constraints.min_order_size
        const maxOrderSize = constraints.max_order_size

        if (!isUsableQuantityStep(quantityStep)) {
            return rejectCalculationInput('constraints.quantity_step', {
                quantityStep: isFiniteQuantity(quantityStep) ? quantityStep : undefined,
            })
        }
        if (!isPositiveFinite(minOrderSize)) {
            return rejectCalculationInput('constraints.min_order_size', { quantityStep })
        }
        if (maxOrderSize !== undefined && (
            !isPositiveFinite(maxOrderSize) || maxOrderSize < minOrderSize
        )) {
            return rejectCalculationInput('constraints.max_order_size', {
                quantityStep,
                minOrderSize,
            })
        }

        const policyValue = inputRecord.policy
        if (!isRecord(policyValue)) return rejectCalculationInput('policy', {
            quantityStep,
            minOrderSize,
            ...(maxOrderSize === undefined ? {} : { maxOrderSize }),
        })
        const policy = policyValue
        const sizingMode = policy.sizing_mode
        if (sizingMode !== 'WEBHOOK_CAPPED' && sizingMode !== 'MANAGED') {
            return rejectCalculationInput('policy.sizing_mode', { quantityStep, minOrderSize })
        }
        if (typeof policy.enabled !== 'boolean') {
            return rejectCalculationInput('policy.enabled', { quantityStep, minOrderSize })
        }
        if (!isPositiveFinite(policy.max_abs_position)) {
            return rejectCalculationInput('policy.max_abs_position', { quantityStep, minOrderSize })
        }
        if (typeof policy.no_flip !== 'boolean') {
            return rejectCalculationInput('policy.no_flip', { quantityStep, minOrderSize })
        }
        if (policy.max_abs_position < minOrderSize) {
            return rejectCalculationInput('policy.max_abs_position', {
                quantityStep,
                minOrderSize,
                maxAbsPosition: policy.max_abs_position,
                noFlip: policy.no_flip,
            })
        }
        if (!isQuantityStepAligned(policy.max_abs_position, quantityStep)) {
            return rejectCalculationInput('policy.max_abs_position', {
                quantityStep,
                minOrderSize,
                maxAbsPosition: policy.max_abs_position,
                noFlip: policy.no_flip,
            })
        }

        if (sizingMode === 'MANAGED') {
            if (!isPositiveFinite(policy.base_order_size)) {
                return rejectCalculationInput('policy.base_order_size', {
                    quantityStep,
                    minOrderSize,
                    maxAbsPosition: policy.max_abs_position,
                    noFlip: policy.no_flip,
                })
            }
            if (policy.base_order_size < minOrderSize || policy.base_order_size > policy.max_abs_position) {
                return rejectCalculationInput('policy.base_order_size', {
                    quantityStep,
                    minOrderSize,
                    maxAbsPosition: policy.max_abs_position,
                    noFlip: policy.no_flip,
                })
            }
            if (!isQuantityStepAligned(policy.base_order_size, quantityStep)) {
                return rejectCalculationInput('policy.base_order_size', {
                    quantityStep,
                    minOrderSize,
                    maxAbsPosition: policy.max_abs_position,
                    noFlip: policy.no_flip,
                })
            }
            if (!isFiniteQuantity(policy.taper_strength) || policy.taper_strength < 0 || policy.taper_strength > 1) {
                return rejectCalculationInput('policy.taper_strength', {
                    quantityStep,
                    minOrderSize,
                    maxAbsPosition: policy.max_abs_position,
                    noFlip: policy.no_flip,
                })
            }
        }

        const confirmedPosition = inputRecord.confirmedPosition
        if (!isFiniteQuantity(confirmedPosition)) {
            return rejectCalculationInput('confirmedPosition', {
                quantityStep,
                minOrderSize,
                maxAbsPosition: policy.max_abs_position,
                noFlip: policy.no_flip,
            })
        }
        const pendingDelta = inputRecord.pendingDelta
        if (!isFiniteQuantity(pendingDelta)) {
            return rejectCalculationInput('pendingDelta', {
                quantityStep,
                minOrderSize,
                maxAbsPosition: policy.max_abs_position,
                noFlip: policy.no_flip,
            })
        }
        const side = inputRecord.side
        if (side !== 'BUY' && side !== 'SELL') {
            return rejectCalculationInput('side', {
                quantityStep,
                minOrderSize,
                maxAbsPosition: policy.max_abs_position,
                noFlip: policy.no_flip,
            })
        }

        const effectivePosition = addQuantities(confirmedPosition, pendingDelta)
        if (effectivePosition === null) {
            return rejectCalculationInput('effectivePosition', {
                quantityStep,
                minOrderSize,
                maxAbsPosition: policy.max_abs_position,
                noFlip: policy.no_flip,
            })
        }
        const details = withCommonDetails(effectivePosition, {
            quantity_step: quantityStep,
            min_order_size: minOrderSize,
            ...(maxOrderSize === undefined ? {} : { max_order_size: maxOrderSize }),
        }, policy)

        if (!policy.enabled) {
            return suppress('POLICY_DISABLED', {
                ...details,
                positionAfter: effectivePosition,
            })
        }

        let candidateSize: number
        if (sizingMode === 'WEBHOOK_CAPPED') {
            const inputSize = inputRecord.inputSize
            if (inputSize === undefined) {
                return {
                    kind: 'REJECT',
                    reason: 'SIZE_REQUIRED',
                    details: invalidDetails('inputSize', details),
                }
            }
            if (!isPositiveFinite(inputSize)) {
                return {
                    kind: 'REJECT',
                    reason: 'INVALID_SIZE',
                    details: invalidDetails('inputSize', details),
                }
            }
            if (!isQuantityStepAligned(inputSize, quantityStep)) {
                return {
                    kind: 'REJECT',
                    reason: 'INVALID_SIZE_INCREMENT',
                    details: invalidDetails('inputSize', { ...details, candidateSize: inputSize }),
                }
            }
            candidateSize = inputSize
        } else {
            const inputSize = inputRecord.inputSize
            if (inputSize !== undefined && !isPositiveFinite(inputSize)) {
                return {
                    kind: 'REJECT',
                    reason: 'INVALID_SIZE',
                    details: invalidDetails('inputSize', details),
                }
            }
            candidateSize = policy.base_order_size as number
        }

        const candidateDetails: SizingDecisionDetails = { ...details, candidateSize }
        const sideDirection = side === 'BUY' ? 1 : -1
        const directionalPosition = multiplyQuantity(effectivePosition, sideDirection)
        const absolutePosition = Math.abs(effectivePosition)
        if (directionalPosition === null || !Number.isFinite(absolutePosition)) {
            return rejectCalculationInput('effectivePosition', candidateDetails)
        }

        // direction と上限超過の判定では誤差許容の比較を使わない。
        // 微小でも実在する position を 0 とみなすと no_flip を破り得るため、
        // また上限を僅かに超えた position を上限内として扱わないためである。
        const positionRelation: QuantityComparisonResult = {
            comparison: directionalPosition < 0 ? -1 : directionalPosition > 0 ? 1 : 0,
        }
        const absolutePositionRelation: QuantityComparisonResult = {
            comparison: absolutePosition < policy.max_abs_position
                ? -1
                : absolutePosition > policy.max_abs_position
                    ? 1
                    : 0,
        }

        const isIncreasingDirection = positionRelation.comparison >= 0
        let rawSize = candidateSize
        if (sizingMode === 'MANAGED' && isIncreasingDirection) {
            const utilizationRatio = absolutePosition / policy.max_abs_position
            if (!Number.isFinite(utilizationRatio)) {
                return rejectCalculationInput('effectivePosition', candidateDetails)
            }
            const utilization = Math.min(Math.max(utilizationRatio, 0), 1)
            const taperFactor = 1 - (policy.taper_strength as number) * utilization
            rawSize = multiplyQuantity(candidateSize, taperFactor) ?? Number.NaN
        }
        if (!isFiniteQuantity(rawSize)) return rejectCalculationInput('calculatedSize', candidateDetails)

        const rawDetails: SizingDecisionDetails = { ...candidateDetails, rawSize }
        if (absolutePositionRelation.comparison > 0 && isIncreasingDirection) {
            return suppress('MAX_POSITION', {
                ...rawDetails,
                constrainedSize: 0,
                roundedSize: 0,
                effectiveSize: 0,
                positionAfter: effectivePosition,
                appliedConstraints: ['MAX_POSITION', 'QUANTITY_STEP'],
            })
        }

        let constrainedSize = rawSize
        let maxPositionLimited = false
        let noFlipLimited = false
        let maxOrderLimited = false
        let exactHeadroom: number | null = null

        if (absolutePositionRelation.comparison > 0) {
            // 上限超過中は、反対方向でも flat を越えて反転させない。
            const limit = absolutePosition
            const clamped = clampByLimit(constrainedSize, limit, rawDetails, 'effectivePosition')
            if ('decision' in clamped) return clamped.decision
            constrainedSize = clamped.value
            maxPositionLimited = clamped.limited
        } else if (isIncreasingDirection) {
            exactHeadroom = subtractQuantities(policy.max_abs_position, directionalPosition)
            if (exactHeadroom === null) return rejectCalculationInput('maxPositionHeadroom', rawDetails)
            const headroom = subtractQuantities(policy.max_abs_position, directionalPosition, quantityStep)
            if (headroom === null) return rejectCalculationInput('maxPositionHeadroom', rawDetails)
            const headroomRelation = compareOrReject(headroom, 0, quantityStep, rawDetails, 'maxPositionHeadroom')
            if ('decision' in headroomRelation) return headroomRelation.decision
            if (headroomRelation.comparison <= 0) {
                return suppress('MAX_POSITION', {
                    ...rawDetails,
                    constrainedSize: 0,
                    roundedSize: 0,
                    effectiveSize: 0,
                    positionAfter: effectivePosition,
                    appliedConstraints: ['MAX_POSITION', 'QUANTITY_STEP'],
                })
            }
            const clamped = clampByLimit(constrainedSize, headroom, rawDetails, 'maxPositionHeadroom')
            if ('decision' in clamped) return clamped.decision
            constrainedSize = clamped.value
            maxPositionLimited = clamped.limited
        } else if (policy.no_flip) {
            const flatLimit = absolutePosition
            const clamped = clampByLimit(constrainedSize, flatLimit, rawDetails, 'effectivePosition')
            if ('decision' in clamped) return clamped.decision
            constrainedSize = clamped.value
            noFlipLimited = clamped.limited
        } else {
            const postFlipHeadroom = addQuantities(policy.max_abs_position, absolutePosition)
            if (postFlipHeadroom === null) return rejectCalculationInput('maxPositionHeadroom', rawDetails)
            const clamped = clampByLimit(constrainedSize, postFlipHeadroom, rawDetails, 'maxPositionHeadroom')
            if ('decision' in clamped) return clamped.decision
            constrainedSize = clamped.value
            maxPositionLimited = clamped.limited
        }

        if (maxOrderSize !== undefined) {
            const clamped = clampByLimit(constrainedSize, maxOrderSize, rawDetails, 'constraints.max_order_size')
            if ('decision' in clamped) return clamped.decision
            constrainedSize = clamped.value
            maxOrderLimited = clamped.limited
        }

        if (!isFiniteQuantity(constrainedSize) || constrainedSize < 0) {
            return rejectCalculationInput('constrainedSize', rawDetails)
        }
        let roundedSize = floorToQuantityStep(constrainedSize, quantityStep)
        if (roundedSize === null) return rejectCalculationInput('calculatedSize', {
            ...rawDetails,
            constrainedSize,
        })

        const appliedConstraints: SizingConstraint[] = [...rawDetails.appliedConstraints]
        if (maxPositionLimited) appliedConstraints.push('MAX_POSITION')
        if (noFlipLimited) appliedConstraints.push('NO_FLIP')
        if (maxOrderLimited) appliedConstraints.push('MAX_ORDER_SIZE')
        appliedConstraints.push('QUANTITY_STEP')

        let positionAfter = buildPositionAfter(effectivePosition, roundedSize, side)
        if (positionAfter === null) return rejectCalculationInput('positionAfter', {
            ...rawDetails,
            constrainedSize,
            roundedSize,
            appliedConstraints,
        })

        // step-aware headroom は `5 - 4.9 = 0.1` のような有効な一 step を
        // 復元する一方、加算結果が上限を数値上超えることは許可しない。
        // canonical 表現で超過した場合は、通常の減算結果へ戻してから
        // min 判定を行う。
        if (
            isIncreasingDirection
            && absolutePositionRelation.comparison <= 0
            && Math.abs(positionAfter) > policy.max_abs_position
            && exactHeadroom !== null
        ) {
            constrainedSize = Math.min(constrainedSize, exactHeadroom)
            roundedSize = floorToQuantityStep(constrainedSize, quantityStep)
            if (roundedSize === null) return rejectCalculationInput('calculatedSize', {
                ...rawDetails,
                constrainedSize,
                appliedConstraints,
            })
            positionAfter = buildPositionAfter(effectivePosition, roundedSize, side)
            if (positionAfter === null) return rejectCalculationInput('positionAfter', {
                ...rawDetails,
                constrainedSize,
                roundedSize,
                appliedConstraints,
            })
            if (!appliedConstraints.includes('MAX_POSITION')) appliedConstraints.push('MAX_POSITION')
            maxPositionLimited = true
        }

        const exceedsMaxPosition =
            absolutePositionRelation.comparison <= 0
            && Math.abs(positionAfter) > policy.max_abs_position
        if (exceedsMaxPosition) {
            if (!appliedConstraints.includes('MAX_POSITION')) appliedConstraints.push('MAX_POSITION')
            return suppress('MAX_POSITION', {
                ...rawDetails,
                constrainedSize,
                roundedSize,
                effectiveSize: roundedSize,
                positionAfter,
                appliedConstraints,
            })
        }

        const crossesFlat = policy.no_flip && (
            (effectivePosition > 0 && side === 'SELL' && positionAfter < 0)
            || (effectivePosition < 0 && side === 'BUY' && positionAfter > 0)
        )
        if (crossesFlat) {
            if (!appliedConstraints.includes('NO_FLIP')) appliedConstraints.push('NO_FLIP')
            return suppress('NO_FLIP', {
                ...rawDetails,
                constrainedSize,
                roundedSize,
                effectiveSize: roundedSize,
                positionAfter,
                appliedConstraints,
            })
        }

        if (maxOrderSize !== undefined && roundedSize > maxOrderSize) {
            return rejectCalculationInput('calculatedSize', {
                ...rawDetails,
                constrainedSize,
                roundedSize,
                appliedConstraints,
                positionAfter,
            })
        }

        // min_order_size は broker の安全閾値であり、step 境界の
        // IEEE 754 許容差を使わず数値上厳密に比較する。
        if (roundedSize < minOrderSize) {
            const reason = noFlipLimited
                ? 'NO_FLIP'
                : maxPositionLimited
                    ? 'MAX_POSITION'
                    : 'BELOW_MIN_ORDER_SIZE'
            appliedConstraints.push('MIN_ORDER_SIZE')
            return suppress(reason, {
                ...rawDetails,
                constrainedSize,
                roundedSize,
                effectiveSize: roundedSize,
                positionAfter,
                appliedConstraints,
            })
        }

        if (roundedSize <= 0 || !isFiniteQuantity(roundedSize)) {
            return rejectCalculationInput('calculatedSize', {
                ...rawDetails,
                constrainedSize,
                roundedSize,
                appliedConstraints,
                positionAfter,
            })
        }

        return {
            kind: 'DISPATCH',
            effectiveSize: roundedSize,
            reason: 'CALCULATED',
            details: {
                ...rawDetails,
                constrainedSize,
                roundedSize,
                effectiveSize: roundedSize,
                positionAfter,
                appliedConstraints,
            },
        }
    } catch {
        // runtime で型契約外の object/getter が渡されても発注可能数量へ
        // フォールバックしない。
        return rejectCalculationInput('input')
    }
}

/**
 * 数量計算で使用する浮動小数点演算の境界を一箇所に集約する。
 *
 * このモジュールが許容するのは IEEE 754 の演算で発生する誤差だけであり、
 * quantity_step と整合しない入力を丸めて受理するためには使用しない。
 */

const STEP_ULP_FACTOR = 2
const STEP_RELATIVE_TOLERANCE = Number.EPSILON * 1000

export type QuantityComparison = -1 | 0 | 1

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value)

/** 数値として扱える有限な数量かを判定する。 */
export const isFiniteQuantity = isFiniteNumber

const toleranceFor = (left: number, right: number, step: number): number => Math.min(
    STEP_ULP_FACTOR * Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)),
    step * STEP_RELATIVE_TOLERANCE,
)

const isUsableStep = (step: number): boolean => {
    if (!isFiniteNumber(step) || step <= 0) return false

    // 相対許容幅自体が underflow する step は、step 境界を安全に
    // 識別できる誤差モデルを構成できないため受理しない。
    const relativeTolerance = step * STEP_RELATIVE_TOLERANCE
    if (!(relativeTolerance > 0)) return false

    // step が小さすぎる場合、1 step の半分を IEEE 754 の誤差としてしか
    // 区別できないため、比較・丸めを安全に行えない。
    return toleranceFor(0, step, step) < step / 2
}

/** quantity_step が安全に数量演算へ使用できる値かを判定する。 */
export const isUsableQuantityStep = (step: unknown): step is number =>
    typeof step === 'number' && isUsableStep(step)

const nearestStepIndex = (value: number, step: number): number | null => {
    if (!isFiniteNumber(value) || !isUsableStep(step)) return null

    const quotient = value / step
    if (!Number.isFinite(quotient)) return null

    const nearest = Math.round(quotient)
    if (!Number.isSafeInteger(nearest)) return null

    const nearestMultiple = nearest * step
    if (!Number.isFinite(nearestMultiple)) return null

    return nearest
}

/**
 * value が step の整数倍かを判定する。
 * 近似を許容する範囲は、演算由来の ulp 誤差に限定する。
 */
export const isQuantityStepAligned = (value: unknown, step: unknown): value is number => {
    if (!isFiniteNumber(value) || !isFiniteNumber(step) || !isUsableStep(step)) return false
    if (value === 0) return true

    const nearest = nearestStepIndex(value, step)
    if (nearest === null) return false

    const nearestMultiple = nearest * step
    const tolerance = toleranceFor(value, nearestMultiple, step)
    // 半 step 以上を誤差扱いすることになる値は、入力の正否を安全に
    // 識別できないため fail-closed とする。
    return tolerance < step / 2 && Math.abs(value - nearestMultiple) <= tolerance
}

/**
 * 正の数量を quantity_step 単位で下方向へ丸める。
 * 安全に step の整数比を表現できない場合は null を返す。
 */
export const floorToQuantityStep = (value: unknown, step: unknown): number | null => {
    if (!isFiniteNumber(value) || !isFiniteNumber(step) || !isUsableStep(step) || value < 0) {
        return null
    }
    if (value === 0) return 0

    const quotient = value / step
    if (!Number.isFinite(quotient) || quotient > Number.MAX_SAFE_INTEGER) return null

    const nearest = Math.round(quotient)
    if (!Number.isSafeInteger(nearest)) return null
    const nearestMultiple = nearest * step
    if (!Number.isFinite(nearestMultiple)) return null

    const tolerance = toleranceFor(value, nearestMultiple, step)
    const isNearBoundary = tolerance < step / 2 && Math.abs(value - nearestMultiple) <= tolerance
    const index = isNearBoundary ? nearest : Math.floor(quotient)
    if (!Number.isSafeInteger(index) || index < 0) return null

    let result = index * step
    if (!Number.isFinite(result)) return null

    // step 境界の IEEE 754 誤差で乗算結果だけが僅かに上回った場合は、
    // 入力値そのものを返して数値上の上方向丸めを避ける。これは
    // isQuantityStepAligned が許容する同じ境界の表現である。
    if (result > value) {
        if (isNearBoundary) {
            // canonical な step 表現が IEEE 754 の丸めで入力を僅かに
            // 上回る場合は、入力表現を維持する。step 整合判定では同じ
            // 境界の表現として扱うが、floor の数値契約は必ず value 以下
            // とする。
            result = value
        } else {
            // 境界から十分離れた値であれば、乗算の丸めで理論上の下限を
            // 上回ったものとして、もう一段下げる。
            result = (index - 1) * step
        }
    }
    if (!Number.isFinite(result) || result < 0) return null

    return Object.is(result, -0) ? 0 : result
}

/** 有限性を確認した加算。position の加算にも使用する。 */
export const addQuantities = (left: unknown, right: unknown): number | null => {
    if (!isFiniteNumber(left) || !isFiniteNumber(right)) return null
    const result = left + right
    return Number.isFinite(result) ? (Object.is(result, -0) ? 0 : result) : null
}

/**
 * 有限性を確認した減算。step を指定した場合、両オペランドが同じ
 * quantity_step の境界表現であれば、境界の index 同士を減算して
 * headroom を算出する。これは `5 - 4.9` のような演算誤差で、実際は
 * 1 step 残っている headroom が `0.09999999999999964` になることを
 * 防ぐためのものだが、呼び出し側では注文後の position を数値上厳密に
 * 検証し、canonical 化による上限超過を許可してはならない。
 */
export const subtractQuantities = (
    left: unknown,
    right: unknown,
    step?: unknown,
): number | null => {
    if (!isFiniteNumber(left) || !isFiniteNumber(right)) return null
    const result = left - right
    if (!Number.isFinite(result)) return null

    if (step !== undefined) {
        if (!isFiniteNumber(step) || !isUsableStep(step)) return null
        const leftIndex = nearestStepIndex(left, step)
        const rightIndex = nearestStepIndex(right, step)
        if (
            leftIndex !== null
            && rightIndex !== null
            && isQuantityStepAligned(left, step)
            && isQuantityStepAligned(right, step)
        ) {
            const indexDifference = leftIndex - rightIndex
            if (Number.isSafeInteger(indexDifference)) {
                const canonicalResult = indexDifference * step
                if (Number.isFinite(canonicalResult)) {
                    return Object.is(canonicalResult, -0) ? 0 : canonicalResult
                }
            }
        }
    }

    return Object.is(result, -0) ? 0 : result
}

/** 有限性を確認した乗算。漸減率と符号付き数量の計算に使用する。 */
export const multiplyQuantity = (left: unknown, right: unknown): number | null => {
    if (!isFiniteNumber(left) || !isFiniteNumber(right)) return null
    const result = left * right
    return Number.isFinite(result) ? (Object.is(result, -0) ? 0 : result) : null
}

/**
 * step に応じた ulp 許容で数量を比較する。
 * null は入力または step を安全に比較できないことを表す。
 */
export const compareQuantities = (
    left: unknown,
    right: unknown,
    step: unknown,
): QuantityComparison | null => {
    if (!isFiniteNumber(left) || !isFiniteNumber(right) || !isFiniteNumber(step) || !isUsableStep(step)) {
        return null
    }

    const difference = left - right
    if (!Number.isFinite(difference)) return null

    const tolerance = toleranceFor(left, right, step)
    if (Math.abs(difference) <= tolerance) return 0
    return difference < 0 ? -1 : 1
}

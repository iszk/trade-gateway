import { isExecutedOrderV2 } from '../types/order-v2.js'
import type { OrderV2 } from '../types/order-v2.js'

export type StatsV2 = {
    strategy: string
    current_position: number
    average_entry_price: number | null
    realized_pnl: number
    win_rate: number
    total_trades: number
    winning_trades: number
    losing_trades: number
    profit_factor: number
    max_drawdown: number
    sharpe_ratio: number | null
    avg_pnl: number | null
    avg_win: number | null
    avg_loss: number | null
    open_orders: number
}

/**
 * 渡された OrderV2 の履歴 (EXECUTED のみ) を時系列順にリプレイし、
 * 現在のポジション、平均取得単価、PnL 等を計算する。
 */
const EPSILON = 0.00000001

export const computeStatsV2 = (orders: OrderV2[], strategy: string): StatsV2 => {
    // EXECUTED 注文は executed_at を日時基準にする。欠落した旧データは集計対象外。
    const executedOrders = orders
        .filter(isExecutedOrderV2)
        .sort((a, b) => a.executed_at.getTime() - b.executed_at.getTime() || a.id.localeCompare(b.id))

    const openOrders = orders.filter((o) => o.status === 'PENDING').length

    let currentPosition = 0
    let averageEntryPrice: number | null = null
    let realizedPnl = 0
    let totalTrades = 0
    let winningTrades = 0
    let losingTrades = 0

    const tradePnls: number[] = []
    let grossProfit = 0
    let grossLoss = 0
    let peakCumPnl = 0
    let cumPnl = 0
    let maxDrawdown = 0

    for (const order of executedOrders) {
        const size = order.executed_size || order.requested_size
        if (size < EPSILON) continue

        const price = order.executed_price
        const isBuy = order.side === 'BUY'

        if (Math.abs(currentPosition) < EPSILON) {
            // 新規エントリー
            currentPosition = isBuy ? size : -size
            averageEntryPrice = price
        } else if ((currentPosition > EPSILON && isBuy) || (currentPosition < -EPSILON && !isBuy)) {
            // ピラミッディング (増し玉)
            const currentAbsPosition = Math.abs(currentPosition)
            const newAbsPosition = currentAbsPosition + size

            // 平均取得単価の再計算
            averageEntryPrice = ((averageEntryPrice! * currentAbsPosition) + (price * size)) / newAbsPosition
            currentPosition = isBuy ? currentPosition + size : currentPosition - size
        } else {
            // 決済 (ドテン・部分決済・全決済を含む)
            const isLong = currentPosition > EPSILON
            const currentAbsPosition = Math.abs(currentPosition)
            const closeSize = Math.min(currentAbsPosition, size)

            // PnL の計算
            const pnl = isLong
                ? (price - averageEntryPrice!) * closeSize
                : (averageEntryPrice! - price) * closeSize

            realizedPnl += pnl
            cumPnl += pnl
            tradePnls.push(pnl)
            totalTrades++

            if (pnl > EPSILON) {
                winningTrades++
                grossProfit += pnl
            } else if (pnl < -EPSILON) {
                losingTrades++
                grossLoss += Math.abs(pnl)
            }

            // Max Drawdown の計算
            if (cumPnl > peakCumPnl) {
                peakCumPnl = cumPnl
            }
            const drawdown = peakCumPnl - cumPnl
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown
            }

            // ポジションの更新
            if (size > currentAbsPosition + EPSILON) {
                // ドテン (反転)
                const remainingSize = Math.round((size - currentAbsPosition) * 1e8) / 1e8
                currentPosition = isBuy ? remainingSize : -remainingSize
                averageEntryPrice = price // 新規ポジションの単価は今回の価格
            } else if (Math.abs(size - currentAbsPosition) < EPSILON) {
                // 全決済
                currentPosition = 0
                averageEntryPrice = null
            } else {
                // 部分決済
                currentPosition = isBuy ? currentPosition + size : currentPosition - size
                // 平均単価は変わらない
            }
        }
    }

    const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0
    const profitFactor = grossLoss > EPSILON ? grossProfit / grossLoss : grossProfit > EPSILON ? Infinity : 0
    const avgPnl = totalTrades > 0 ? realizedPnl / totalTrades : null
    const avgWin = winningTrades > 0 ? grossProfit / winningTrades : null
    const avgLoss = losingTrades > 0 ? grossLoss / losingTrades : null

    // Sharpe Ratio（リスクフリーレート 0、トレード単位）
    let sharpeRatio: number | null = null
    if (tradePnls.length >= 2) {
        const mean = realizedPnl / tradePnls.length
        const variance = tradePnls.reduce((acc, pnl) => acc + (pnl - mean) ** 2, 0) / tradePnls.length
        const stdDev = Math.sqrt(variance)
        sharpeRatio = stdDev > EPSILON ? mean / stdDev : null
    }

    return {
        strategy,
        current_position: currentPosition,
        average_entry_price: averageEntryPrice,
        realized_pnl: realizedPnl,
        win_rate: winRate,
        total_trades: totalTrades,
        winning_trades: winningTrades,
        losing_trades: losingTrades,
        profit_factor: profitFactor,
        max_drawdown: maxDrawdown,
        sharpe_ratio: sharpeRatio,
        avg_pnl: avgPnl,
        avg_win: avgWin,
        avg_loss: avgLoss,
        open_orders: openOrders,
    }
}

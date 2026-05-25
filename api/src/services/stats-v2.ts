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
}

/**
 * 渡された OrderV2 の履歴 (EXECUTED のみ) を時系列順にリプレイし、
 * 現在のポジション、平均取得単価、PnL 等を計算する。
 */
const EPSILON = 0.00000001

export const computeStatsV2 = (orders: OrderV2[], strategy: string): StatsV2 => {
    // 確定済みの注文だけを対象に、古い順にソートする
    // created_at が等しい場合は ID で安定させる
    const executedOrders = orders
        .filter((o) => o.status === 'EXECUTED' && o.executed_price !== null)
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id))

    let currentPosition = 0
    let averageEntryPrice: number | null = null
    let realizedPnl = 0
    let totalTrades = 0
    let winningTrades = 0
    let losingTrades = 0

    for (const order of executedOrders) {
        const size = order.executed_size || order.requested_size
        if (size < EPSILON) continue

        const price = order.executed_price!
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
            totalTrades++
            if (pnl > EPSILON) {
                winningTrades++
            } else if (pnl < -EPSILON) {
                losingTrades++
            }

            // ポジションの更新
            if (size > currentAbsPosition + EPSILON) {
                // ドテン (反転)
                const remainingSize = size - currentAbsPosition
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

    return {
        strategy,
        current_position: currentPosition,
        average_entry_price: averageEntryPrice,
        realized_pnl: realizedPnl,
        win_rate: winRate,
        total_trades: totalTrades,
        winning_trades: winningTrades,
        losing_trades: losingTrades,
    }
}

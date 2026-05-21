import type { OrderExecution } from '../types/execution.js'
import type { Trade } from '../types/trade.js'

export type MatchedPair = {
    entry: OrderExecution
    exit: OrderExecution
}

export type MatchResult = {
    matched: MatchedPair[]
    /** マッチングされずに残った約定（ポジション保有中） */
    remaining: OrderExecution[]
}

const groupingKey = (e: OrderExecution) =>
    `${e.strategy}|${e.symbol}|${e.interval}|${e.broker}`

/**
 * マーケット注文を FIFO でペアリングする（純粋関数・DB 依存なし）。
 *
 * strategy × symbol × interval × broker でグループ化し、
 * 時系列順に反対サイドの注文が見つかり次第ペアにする。
 *
 * 例: BUY@100, BUY@110, SELL@120, SELL@125
 *   → Trade(entry=BUY@100, exit=SELL@120)
 *   → Trade(entry=BUY@110, exit=SELL@125)
 *   → remaining: []
 */
export const matchMarketExecutions = (executions: OrderExecution[]): MatchResult => {
    const groups = new Map<string, OrderExecution[]>()

    for (const e of executions) {
        const key = groupingKey(e)
        const group = groups.get(key) ?? []
        group.push(e)
        groups.set(key, group)
    }

    const matched: MatchedPair[] = []
    const remaining: OrderExecution[] = []

    for (const group of groups.values()) {
        // 時系列昇順（FIFO）
        const sorted = [...group].sort((a, b) => a.executed_at.getTime() - b.executed_at.getTime())

        // open: まだクローズされていないポジション
        const open: OrderExecution[] = []

        for (const execution of sorted) {
            const oppositeIdx = open.findIndex((o) => o.side !== execution.side)
            if (oppositeIdx !== -1) {
                // 反対サイドが存在 → クローズ
                const [entry] = open.splice(oppositeIdx, 1) as [OrderExecution]
                matched.push({ entry, exit: execution })
            } else {
                open.push(execution)
            }
        }

        remaining.push(...open)
    }

    return { matched, remaining }
}

/**
 * IFDOCO のエントリーとエグジットを entry_id で突合する（純粋関数・DB 依存なし）。
 *
 * - exits: entry_id を持つ OrderExecution
 * - entries: provider_order_id を持ち entry_id を持たない OrderExecution
 */
export const matchIfdocoExecutions = (
    entries: OrderExecution[],
    exits: OrderExecution[],
): MatchResult => {
    const entryMap = new Map(entries.map((e) => [e.id, e]))

    const matched: MatchedPair[] = []
    const unmatchedExits: OrderExecution[] = []

    for (const exit of exits) {
        const entry = entryMap.get(exit.entry_id!)
        if (entry) {
            matched.push({ entry, exit })
            entryMap.delete(entry.id)
        } else {
            unmatchedExits.push(exit)
        }
    }

    return {
        matched,
        // 未対応のエントリー（エグジットがまだ）＋ 対応エントリーが見つからなかったエグジット
        remaining: [...entryMap.values(), ...unmatchedExits],
    }
}

/**
 * MatchedPair から Trade データ（id 以外）を生成する。
 * entry_side は先に来た方（entry.executed_at が古い方）で決まる。
 */
export const buildTrade = (pair: MatchedPair): Omit<Trade, 'id'> => {
    const { entry, exit } = pair
    const isLong = entry.side === 'BUY'
    const pnl = isLong
        ? (exit.price - entry.price) * entry.size
        : (entry.price - exit.price) * entry.size

    return {
        strategy: entry.strategy,
        symbol: entry.symbol,
        interval: entry.interval,
        broker: entry.broker,
        entry_side: entry.side,
        entry_price: entry.price,
        exit_price: exit.price,
        size: entry.size,
        pnl,
        entry_id: entry.id,
        exit_id: exit.id,
        opened_at: entry.executed_at,
        closed_at: exit.executed_at,
    }
}

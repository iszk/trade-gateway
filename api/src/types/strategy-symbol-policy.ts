export type StrategySymbolSizingMode = 'WEBHOOK_CAPPED' | 'MANAGED'

type StrategySymbolPolicyCommon = {
    id: string
    strategy_id: string
    symbol_id: string
    enabled: boolean
    max_abs_position: number
    no_flip: boolean
    version: number
    created_at: Date
    updated_at: Date
}

export type WebhookCappedStrategySymbolPolicy = StrategySymbolPolicyCommon & {
    sizing_mode: 'WEBHOOK_CAPPED'
}

export type ManagedStrategySymbolPolicy = StrategySymbolPolicyCommon & {
    sizing_mode: 'MANAGED'
    base_order_size: number
    taper_strength: number
}

export type StrategySymbolPolicy =
    | WebhookCappedStrategySymbolPolicy
    | ManagedStrategySymbolPolicy

export type StrategySymbolPolicyInput = {
    strategy_id: string
    symbol_id: string
    enabled: boolean
    max_abs_position: number
    no_flip: boolean
} & (
    | {
        sizing_mode: 'WEBHOOK_CAPPED'
    }
    | {
        sizing_mode: 'MANAGED'
        base_order_size: number
        taper_strength: number
    }
)

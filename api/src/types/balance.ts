export type BrokerName = 'bitflyer' | 'saxo' | 'dummy'

export type Balance = {
    asset: string
    amount: number
}

export type BrokerBalance = {
    broker: BrokerName
    balances: Balance[]
    updatedAt: number
}

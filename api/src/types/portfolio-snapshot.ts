export const portfolioSnapshotV1SchemaVersion = 'portfolio-snapshot.v1'

export type PortfolioSnapshotV1AssetClass =
    | 'cash'
    | 'stock'
    | 'etf'
    | 'fund'
    | 'bond'
    | 'option'
    | 'future'
    | 'cfd'
    | 'fx'

export type PortfolioSnapshotV1PositionSide = 'long' | 'short' | 'flat'

export type PortfolioSnapshotV1JsonValue =
    | string
    | number
    | boolean
    | null
    | PortfolioSnapshotV1JsonValue[]
    | { [key: string]: PortfolioSnapshotV1JsonValue }

export type PortfolioSnapshotV1SourceMetadata = Record<string, PortfolioSnapshotV1JsonValue>

export type PortfolioSnapshotV1 = {
    schemaVersion: typeof portfolioSnapshotV1SchemaVersion
    source: {
        id: string
        provider: string
        exporter?: string
    }
    generatedAt: string
    dataAsOf: string
    baseCurrency: string
    accounts: Array<{
        sourceAccountId: string
        name?: string
        accountType?: string
        baseCurrency?: string
        sourceMetadata?: PortfolioSnapshotV1SourceMetadata
    }>
    cashBalances: Array<{
        sourceAccountId: string
        currency: string
        amount: string
        valueJpy: string
        fxRateToJpy?: string
        sourceBalanceId?: string
        sourceMetadata?: PortfolioSnapshotV1SourceMetadata
    }>
    positions: Array<{
        sourceAccountId: string
        sourcePositionId: string
        sourceInstrumentId: string
        assetClass: PortfolioSnapshotV1AssetClass
        symbol: string
        name?: string
        quantity: string
        side?: PortfolioSnapshotV1PositionSide
        price?: string
        priceCurrency?: string
        valueJpy: string
        costBasisJpy?: string
        unrealizedPnlJpy?: string
        sourceMetadata?: PortfolioSnapshotV1SourceMetadata
    }>
    sourceMetadata?: PortfolioSnapshotV1SourceMetadata
}

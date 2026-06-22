import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient, setFirestoreDocument } from '../firestore.js'
import { BitflyerClient } from '../brokers/bitflyer.js'
import { SaxoClient } from '../brokers/saxo.js'
import { config } from '../config.js'
import type { BrokerBalance, Balance } from '../types/balance.js'
import type { BrokerName } from '../types/balance.js'

export class BalanceFetcher {
    private readonly db: Firestore
    private readonly bitflyerClient: BitflyerClient
    private readonly saxoClient: SaxoClient
    private readonly now: () => Date

    constructor(options: { db?: Firestore, bitflyerClient?: BitflyerClient, saxoClient?: SaxoClient, now?: () => Date } = {}) {
        this.db = options.db ?? getFirestoreClient()
        this.bitflyerClient = options.bitflyerClient ?? new BitflyerClient(config.bitflyer)
        this.saxoClient = options.saxoClient ?? new SaxoClient(config.saxo)
        this.now = options.now ?? (() => new Date())
    }

    private getJstDate(): string {
        const now = this.now()
        // Format as YYYY-MM-DD in JST
        return now.toLocaleDateString('ja-JP', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            timeZone: 'Asia/Tokyo'
        }).replace(/\//g, '-')
    }

    private async storeBrokerBalance(broker: BrokerName, balances: Balance[], date: string): Promise<BrokerBalance> {
        const brokerBalance: BrokerBalance = {
            broker,
            balances,
            updatedAt: Date.now()
        }

        const docId = `${date}_${broker}`
        const docRef = this.db.collection('daily_balances').doc(docId)

        await setFirestoreDocument(docRef, {
            ...brokerBalance,
            date
        }, {
            collection: 'daily_balances',
            docId,
        })

        return brokerBalance
    }

    async fetchAndStoreBitflyerBalances(date = this.getJstDate()): Promise<BrokerBalance> {
        const [balances, collateral] = await Promise.all([
            this.bitflyerClient.getBalances(),
            this.bitflyerClient.getCollateral()
        ])

        const filteredBalances: Balance[] = balances
            .filter(b => b.amount !== 0)
            .map(b => ({
                asset: b.currency_code,
                amount: b.amount
            }))

        if (collateral && collateral.collateral !== 0) {
            filteredBalances.push({
                asset: 'CFD_JPY',
                amount: collateral.collateral
            })
        }

        return this.storeBrokerBalance('bitflyer', filteredBalances, date)
    }

    async fetchAndStoreSaxoBalances(date = this.getJstDate()): Promise<BrokerBalance> {
        const balances = await this.saxoClient.getBalances()
        return this.storeBrokerBalance('saxo', balances, date)
    }

    async fetchAllBalances(): Promise<BrokerBalance[]> {
        const date = this.getJstDate()
        const [bitflyerBalance, saxoBalance] = await Promise.all([
            this.fetchAndStoreBitflyerBalances(date),
            this.fetchAndStoreSaxoBalances(date),
        ])
        return [bitflyerBalance, saxoBalance]
    }
}

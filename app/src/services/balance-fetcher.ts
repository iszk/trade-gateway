import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient } from '../firestore.js'
import { BitflyerClient } from '../brokers/bitflyer.js'
import { config } from '../config.js'
import type { BrokerBalance, Balance } from '../types/balance.js'

export class BalanceFetcher {
    private readonly db: Firestore
    private readonly bitflyerClient: BitflyerClient

    constructor(options: { db?: Firestore, bitflyerClient?: BitflyerClient } = {}) {
        this.db = options.db ?? getFirestoreClient()
        this.bitflyerClient = options.bitflyerClient ?? new BitflyerClient(config.bitflyer)
    }

    private getJstDate(): string {
        const now = new Date()
        // Format as YYYY-MM-DD in JST
        return now.toLocaleDateString('ja-JP', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            timeZone: 'Asia/Tokyo'
        }).replace(/\//g, '-')
    }

    async fetchAndStoreBitflyerBalances(): Promise<BrokerBalance> {
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

        const brokerBalance: BrokerBalance = {
            broker: 'bitflyer',
            balances: filteredBalances,
            updatedAt: Date.now()
        }

        const date = this.getJstDate()
        const docId = `${date}_bitflyer`
        const docRef = this.db.collection('daily_balances').doc(docId)

        await docRef.set({
            ...brokerBalance,
            date
        })

        return brokerBalance
    }

    async fetchAllBalances(): Promise<BrokerBalance[]> {
        // For now, only bitflyer is implemented as requested
        const bitflyerBalance = await this.fetchAndStoreBitflyerBalances()
        return [bitflyerBalance]
    }
}

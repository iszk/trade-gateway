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

    constructor(options: { db?: Firestore, bitflyerClient?: BitflyerClient, saxoClient?: SaxoClient } = {}) {
        this.db = options.db ?? getFirestoreClient()
        this.bitflyerClient = options.bitflyerClient ?? new BitflyerClient(config.bitflyer)
        this.saxoClient = options.saxoClient ?? new SaxoClient(config.saxo)
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

    private async storeBrokerBalance(broker: BrokerName, balances: Balance[]): Promise<BrokerBalance> {
        const brokerBalance: BrokerBalance = {
            broker,
            balances,
            updatedAt: Date.now()
        }

        const date = this.getJstDate()
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

        return this.storeBrokerBalance('bitflyer', filteredBalances)
    }

    async fetchAndStoreSaxoBalances(): Promise<BrokerBalance> {
        const balances = await this.saxoClient.getBalances()
        return this.storeBrokerBalance('saxo', balances)
    }

    async fetchAllBalances(): Promise<BrokerBalance[]> {
        const [bitflyerBalance, saxoBalance] = await Promise.all([
            this.fetchAndStoreBitflyerBalances(),
            this.fetchAndStoreSaxoBalances(),
        ])
        return [bitflyerBalance, saxoBalance]
    }
}

export type SaxoOrderActivity = {
    LogId: string
    OrderId: string
    Status: string
    SubStatus?: string
    ExternalReference?: string
    Amount?: number
    FillAmount?: number
    FilledAmount?: number
    ExecutionPrice?: number
    AveragePrice?: number
    ActivityTime?: string
    ExecutionTime?: string
    UtcTime?: string
}

export type SaxoOrderActivitiesResponse = {
    Data: SaxoOrderActivity[]
    __next?: string
    __nextPoll?: string
}

export type SaxoOrderActivitiesPageResult =
    | { complete: true, activities: SaxoOrderActivity[], nextPollUrl?: string }
    | { complete: false, reason: 'HTTP_ERROR' | 'PARSE_ERROR' | 'PAGE_LIMIT' }

export type SaxoOrderActivityResolution = {
    execution: { price: number, size: number, executed_at?: Date } | null
    brokerState:
        | 'FILLED'
        | 'PARTIALLY_FILLED'
        | 'CANCELED'
        | 'EXPIRED'
        | 'PLACEMENT_REJECTED'
        | 'NON_TERMINAL'
        | 'UNRESOLVED'
}

type FetchSaxoOrderActivitiesPagesOptions = {
    initialUrl: string
    fetchPage: (url: string) => Promise<Response>
    resolveNextUrl?: (url: string) => string
    maxPages?: number
    onHttpError?: (response: Response) => Promise<void> | void
}

export const SAXO_ORDER_ACTIVITIES_PAGE_SIZE = 500
export const SAXO_ORDER_ACTIVITIES_MAX_PAGES = 20

const isOptionalString = (value: unknown): boolean => value === undefined || typeof value === 'string'
const isOptionalNumber = (value: unknown): boolean => value === undefined || typeof value === 'number'

const isSaxoOrderActivity = (value: unknown): value is SaxoOrderActivity => {
    if (!value || typeof value !== 'object') return false
    const activity = value as Record<string, unknown>
    return typeof activity.LogId === 'string' &&
        typeof activity.OrderId === 'string' &&
        typeof activity.Status === 'string' &&
        isOptionalString(activity.SubStatus) &&
        isOptionalString(activity.ExternalReference) &&
        isOptionalNumber(activity.Amount) &&
        isOptionalNumber(activity.FillAmount) &&
        isOptionalNumber(activity.FilledAmount) &&
        isOptionalNumber(activity.ExecutionPrice) &&
        isOptionalNumber(activity.AveragePrice) &&
        isOptionalString(activity.ActivityTime) &&
        isOptionalString(activity.ExecutionTime) &&
        isOptionalString(activity.UtcTime)
}

const parseSaxoOrderActivitiesResponse = (value: unknown): SaxoOrderActivitiesResponse | null => {
    if (!value || typeof value !== 'object') return null
    const response = value as Record<string, unknown>
    if (!Array.isArray(response.Data) || !response.Data.every(isSaxoOrderActivity)) return null
    if (!isOptionalString(response.__next) || !isOptionalString(response.__nextPoll)) return null
    return response as SaxoOrderActivitiesResponse
}

export const fetchSaxoOrderActivitiesPages = async (
    options: FetchSaxoOrderActivitiesPagesOptions,
): Promise<SaxoOrderActivitiesPageResult> => {
    const activities: SaxoOrderActivity[] = []
    const maxPages = options.maxPages ?? SAXO_ORDER_ACTIVITIES_MAX_PAGES
    let nextPollUrl: string | undefined
    let url: string | undefined = options.initialUrl

    for (let page = 0; url && page < maxPages; page += 1) {
        let response: Response
        try {
            response = await options.fetchPage(url)
        } catch {
            return { complete: false, reason: 'HTTP_ERROR' }
        }

        if (!response.ok) {
            try {
                await options.onHttpError?.(response)
            } catch {
                // Error reporting must not break the complete/incomplete contract.
            }
            return { complete: false, reason: 'HTTP_ERROR' }
        }

        let rawPage: unknown
        try {
            rawPage = await response.json()
        } catch {
            return { complete: false, reason: 'PARSE_ERROR' }
        }

        const data = parseSaxoOrderActivitiesResponse(rawPage)
        if (!data) return { complete: false, reason: 'PARSE_ERROR' }

        activities.push(...data.Data)
        nextPollUrl = data.__nextPoll ?? nextPollUrl
        url = data.__next
            ? (options.resolveNextUrl?.(data.__next) ?? data.__next)
            : undefined
    }

    if (url) return { complete: false, reason: 'PAGE_LIMIT' }
    return { complete: true, activities, nextPollUrl }
}

export const parseSaxoActivityTime = (activity: SaxoOrderActivity): Date | undefined => {
    const rawTime = activity.ActivityTime ?? activity.ExecutionTime ?? activity.UtcTime
    if (!rawTime) return undefined

    const parsedMs = Date.parse(rawTime)
    if (Number.isNaN(parsedMs)) return undefined
    return new Date(parsedMs)
}

const compareLogIds = (left: string, right: string): number => {
    if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
        return left.length - right.length || left.localeCompare(right)
    }
    return left.localeCompare(right)
}

export const normalizeSaxoOrderActivities = (
    activities: SaxoOrderActivity[],
): SaxoOrderActivity[] => {
    const uniqueActivities = Array.from(
        new Map(activities.map((activity) => [activity.LogId, activity])).values(),
    )
    return uniqueActivities.sort((left, right) => {
        const leftTime = parseSaxoActivityTime(left)?.getTime()
        const rightTime = parseSaxoActivityTime(right)?.getTime()
        if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) {
            return leftTime - rightTime
        }
        if (leftTime !== undefined && rightTime === undefined) return -1
        if (leftTime === undefined && rightTime !== undefined) return 1
        return compareLogIds(left.LogId, right.LogId)
    })
}

const isSaxoFillActivity = (activity: SaxoOrderActivity): boolean => (
    (activity.Status === 'FinalFill' || activity.Status === 'Fill') &&
    (activity.SubStatus === undefined || activity.SubStatus === 'Confirmed') &&
    (typeof activity.ExecutionPrice === 'number' || typeof activity.AveragePrice === 'number')
)

const getSaxoActivityPrice = (activity: SaxoOrderActivity): number | null => (
    typeof activity.ExecutionPrice === 'number'
        ? activity.ExecutionPrice
        : typeof activity.AveragePrice === 'number'
            ? activity.AveragePrice
            : null
)

const getSaxoActivityFillAmount = (activity: SaxoOrderActivity): number | null => {
    if (typeof activity.FillAmount !== 'number') return null
    const amount = Math.abs(activity.FillAmount)
    return amount > 0 ? amount : null
}

const getSaxoActivityCumulativeAmount = (activity: SaxoOrderActivity): number | null => {
    const rawAmount = typeof activity.FilledAmount === 'number'
        ? activity.FilledAmount
        : typeof activity.Amount === 'number'
            ? activity.Amount
            : undefined
    if (typeof rawAmount !== 'number') return null
    const amount = Math.abs(rawAmount)
    return amount > 0 ? amount : null
}

export const aggregateSaxoExecution = (
    activities: SaxoOrderActivity[],
): SaxoOrderActivityResolution['execution'] => {
    const fills = normalizeSaxoOrderActivities(activities).filter(isSaxoFillActivity)
    if (fills.length === 0) return null

    let latestExecutedAt: Date | undefined
    for (const fill of fills) {
        const executedAt = parseSaxoActivityTime(fill)
        if (executedAt && (!latestExecutedAt || executedAt > latestExecutedAt)) {
            latestExecutedAt = executedAt
        }
    }

    const perFillAmounts = fills.map((fill) => ({
        amount: getSaxoActivityFillAmount(fill),
        price: getSaxoActivityPrice(fill),
    }))
    if (perFillAmounts.some((item) => item.amount !== null)) {
        let totalSize = 0
        let totalValue = 0
        for (const item of perFillAmounts) {
            if (item.amount === null || item.price === null) continue
            totalSize += item.amount
            totalValue += item.price * item.amount
        }
        if (totalSize > 0) {
            return { price: totalValue / totalSize, size: totalSize, executed_at: latestExecutedAt }
        }
    }

    const latestFill = fills.at(-1)
    if (!latestFill) return null
    const latestPrice = getSaxoActivityPrice(latestFill)
    if (latestPrice === null) return null

    const cumulativeSize = Math.max(
        ...fills
            .map(getSaxoActivityCumulativeAmount)
            .filter((amount): amount is number => amount !== null),
        0,
    )
    if (cumulativeSize <= 0) return null
    return { price: latestPrice, size: cumulativeSize, executed_at: latestExecutedAt }
}

const resolveSaxoBrokerState = (
    activities: SaxoOrderActivity[],
): SaxoOrderActivityResolution['brokerState'] => {
    let hasConfirmedFinalFill = false
    let hasConfirmedFill = false
    let hasConfirmedCancel = false
    let hasConfirmedExpire = false
    let hasConfirmedPlacement = false
    let hasPlacementRejected = false
    let hasNonTerminal = false
    for (const activity of normalizeSaxoOrderActivities(activities)) {
        const { Status: status, SubStatus: subStatus } = activity
        const isConfirmed = subStatus === undefined || subStatus === 'Confirmed'
        if (status === 'FinalFill' && isConfirmed) {
            hasConfirmedFinalFill = true
        } else if (status === 'Fill' && isConfirmed) {
            hasConfirmedFill = true
        } else if (status === 'Cancelled' && subStatus === 'Confirmed') {
            hasConfirmedCancel = true
        } else if (status === 'Expired' && subStatus === 'Confirmed') {
            hasConfirmedExpire = true
        } else if (status === 'Placed' && subStatus === 'Rejected') {
            hasPlacementRejected = true
        } else if (status === 'Placed' && subStatus === 'Confirmed') {
            hasConfirmedPlacement = true
        } else if (
            (status === 'Placed' || status === 'Changed' || status === 'Working' || status === 'DoneForDay') &&
            (subStatus === 'Confirmed' || subStatus === 'Requested' || subStatus === 'WaitCondition')
        ) {
            hasNonTerminal = true
        }
    }

    if (hasConfirmedFinalFill) {
        if (hasConfirmedCancel && !hasConfirmedExpire) return 'CANCELED'
        if (hasConfirmedExpire && !hasConfirmedCancel) return 'EXPIRED'
        if (hasConfirmedCancel && hasConfirmedExpire) return 'UNRESOLVED'
        return 'FILLED'
    }
    if (hasConfirmedFill) {
        if (hasConfirmedCancel && !hasConfirmedExpire) return 'CANCELED'
        if (hasConfirmedExpire && !hasConfirmedCancel) return 'EXPIRED'
        if (!hasConfirmedCancel && !hasConfirmedExpire) return 'PARTIALLY_FILLED'
        return 'UNRESOLVED'
    }
    if (hasConfirmedCancel && !hasConfirmedExpire && !hasPlacementRejected) return 'CANCELED'
    if (hasConfirmedExpire && !hasConfirmedCancel && !hasPlacementRejected) return 'EXPIRED'
    if ((hasConfirmedCancel || hasConfirmedExpire) && hasPlacementRejected) return 'UNRESOLVED'
    if (hasPlacementRejected && !hasConfirmedPlacement) return 'PLACEMENT_REJECTED'
    if (hasNonTerminal || hasConfirmedPlacement) return 'NON_TERMINAL'
    return 'UNRESOLVED'
}

export const resolveSaxoOrderActivities = (
    activities: SaxoOrderActivity[],
): SaxoOrderActivityResolution => ({
    execution: aggregateSaxoExecution(activities),
    brokerState: resolveSaxoBrokerState(activities),
})

export const summarizeSaxoActivities = (activities: SaxoOrderActivity[]): Record<string, number> => {
    const summary: Record<string, number> = {}
    for (const activity of normalizeSaxoOrderActivities(activities)) {
        const key = activity.SubStatus ? `${activity.Status}:${activity.SubStatus}` : activity.Status
        summary[key] = (summary[key] ?? 0) + 1
    }
    return summary
}

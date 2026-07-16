import assert from 'node:assert/strict'
import test from 'node:test'

import {
    aggregateSaxoExecution,
    fetchSaxoOrderActivitiesPages,
    normalizeSaxoOrderActivities,
    parseSaxoActivityTime,
    resolveSaxoOrderActivities,
    type SaxoOrderActivity,
    type SaxoOrderActivitiesResponse,
} from './saxo-order-activities.js'

const fill = (overrides: Partial<SaxoOrderActivity> = {}): SaxoOrderActivity => ({
    LogId: '1',
    OrderId: 'order-1',
    Status: 'Fill',
    SubStatus: 'Confirmed',
    ExecutionPrice: 100,
    FillAmount: 1,
    ActivityTime: '2026-01-01T00:00:00Z',
    ...overrides,
})

const executionCases: Array<{
    name: string
    activities: SaxoOrderActivity[]
    expected: ReturnType<typeof aggregateSaxoExecution>
}> = [
    {
        name: 'duplicate LogId を二重加算しない',
        activities: [fill({ LogId: '10', FillAmount: 2 }), fill({ LogId: '10', FillAmount: 2 })],
        expected: { price: 100, size: 2, executed_at: new Date('2026-01-01T00:00:00Z') },
    },
    {
        name: '順序が異なる複数 fill を数量加重平均する',
        activities: [
            fill({ LogId: '12', Status: 'FinalFill', ExecutionPrice: 110, FillAmount: 3, ActivityTime: '2026-01-01T00:02:00Z' }),
            fill({ LogId: '11', ExecutionPrice: 90, FillAmount: 1, ActivityTime: '2026-01-01T00:01:00Z' }),
        ],
        expected: { price: 105, size: 4, executed_at: new Date('2026-01-01T00:02:00Z') },
    },
    {
        name: 'FillAmount がなければ最大累積数量と最新価格を使う',
        activities: [
            fill({ LogId: '21', FillAmount: undefined, FilledAmount: 2, AveragePrice: 101, ExecutionPrice: undefined, ActivityTime: '2026-01-01T00:02:00Z' }),
            fill({ LogId: '20', FillAmount: undefined, Amount: 1, AveragePrice: 99, ExecutionPrice: undefined, ActivityTime: '2026-01-01T00:01:00Z' }),
        ],
        expected: { price: 101, size: 2, executed_at: new Date('2026-01-01T00:02:00Z') },
    },
    {
        name: '数量が欠落していれば約定を返さない',
        activities: [fill({ FillAmount: undefined })],
        expected: null,
    },
]

for (const testCase of executionCases) {
    test(`aggregateSaxoExecution: ${testCase.name}`, () => {
        assert.deepEqual(aggregateSaxoExecution(testCase.activities), testCase.expected)
    })
}

test('normalizeSaxoOrderActivities は ActivityTime と数値 LogId で安定して正規化する', () => {
    const activities = [
        fill({ LogId: '10', ActivityTime: '2026-01-01T00:00:00Z' }),
        fill({ LogId: '2', ActivityTime: '2026-01-01T00:00:00Z' }),
        fill({ LogId: '11', ActivityTime: 'invalid' }),
    ]

    assert.deepEqual(normalizeSaxoOrderActivities(activities).map(({ LogId }) => LogId), ['2', '10', '11'])
})

test('parseSaxoActivityTime は activity time field の fallback と不正値を処理する', () => {
    assert.deepEqual(
        parseSaxoActivityTime(fill({ ActivityTime: undefined, ExecutionTime: '2026-01-01T00:03:00Z' })),
        new Date('2026-01-01T00:03:00Z'),
    )
    assert.equal(parseSaxoActivityTime(fill({ ActivityTime: 'invalid' })), undefined)
})

const stateCases: Array<{
    name: string
    activities: SaxoOrderActivity[]
    expected: ReturnType<typeof resolveSaxoOrderActivities>['brokerState']
}> = [
    { name: 'confirmed final fill', activities: [fill({ Status: 'FinalFill' })], expected: 'FILLED' },
    { name: 'confirmed partial fill', activities: [fill()], expected: 'PARTIALLY_FILLED' },
    { name: 'confirmed cancel', activities: [fill({ Status: 'Cancelled', ExecutionPrice: undefined, FillAmount: undefined })], expected: 'CANCELED' },
    { name: 'confirmed expire', activities: [fill({ Status: 'Expired', ExecutionPrice: undefined, FillAmount: undefined })], expected: 'EXPIRED' },
    { name: 'placement rejection', activities: [fill({ Status: 'Placed', SubStatus: 'Rejected', ExecutionPrice: undefined, FillAmount: undefined })], expected: 'PLACEMENT_REJECTED' },
    { name: 'requested placement', activities: [fill({ Status: 'Placed', SubStatus: 'Requested', ExecutionPrice: undefined, FillAmount: undefined })], expected: 'NON_TERMINAL' },
    { name: 'requested fill is ambiguous', activities: [fill({ SubStatus: 'Requested' })], expected: 'UNRESOLVED' },
    { name: 'rejected cancel is ambiguous', activities: [fill({ Status: 'Cancelled', SubStatus: 'Rejected', ExecutionPrice: undefined, FillAmount: undefined })], expected: 'UNRESOLVED' },
    { name: 'unknown status is unresolved', activities: [fill({ Status: 'Unknown', ExecutionPrice: undefined, FillAmount: undefined })], expected: 'UNRESOLVED' },
]

for (const testCase of stateCases) {
    test(`resolveSaxoOrderActivities: ${testCase.name}`, () => {
        assert.equal(resolveSaxoOrderActivities(testCase.activities).brokerState, testCase.expected)
    })
}

test('resolveSaxoOrderActivities は final fill 後の rejected cancel を無視する', () => {
    const resolution = resolveSaxoOrderActivities([
        fill({ LogId: '1', Status: 'FinalFill' }),
        fill({ LogId: '2', Status: 'Cancelled', SubStatus: 'Rejected', ExecutionPrice: undefined, FillAmount: undefined, ActivityTime: '2026-01-01T00:01:00Z' }),
    ])

    assert.equal(resolution.brokerState, 'FILLED')
})

test('resolveSaxoOrderActivities は時刻欠落 activity で FILLED を downgrade しない', () => {
    const resolution = resolveSaxoOrderActivities([
        fill({ LogId: '1', Status: 'FinalFill' }),
        fill({
            LogId: '2',
            Status: 'Placed',
            ActivityTime: undefined,
            ExecutionPrice: undefined,
            FillAmount: undefined,
        }),
        fill({
            LogId: '3',
            Status: 'Placed',
            SubStatus: 'Rejected',
            ActivityTime: undefined,
            ExecutionPrice: undefined,
            FillAmount: undefined,
        }),
    ])

    assert.equal(resolution.brokerState, 'FILLED')
})

test('resolveSaxoOrderActivities は confirmed でない fill を約定へ集約しない', () => {
    assert.equal(resolveSaxoOrderActivities([fill({ SubStatus: 'Requested' })]).execution, null)
    assert.equal(resolveSaxoOrderActivities([fill({ SubStatus: 'Rejected' })]).execution, null)
})

test('fetchSaxoOrderActivitiesPages は全ページ取得後に activities と nextPollUrl を返す', async () => {
    const requestedUrls: string[] = []
    const finalPage: SaxoOrderActivitiesResponse = {
        Data: [fill({ LogId: '2' })],
        __nextPoll: '/poll-2',
    }
    const result = await fetchSaxoOrderActivitiesPages({
        initialUrl: 'https://example.com/page-1',
        resolveNextUrl: (url) => `https://example.com${url}`,
        fetchPage: async (url) => {
            requestedUrls.push(url)
            if (url.endsWith('page-1')) {
                return Response.json({ Data: [fill({ LogId: '1' })], __next: '/page-2', __nextPoll: '/poll-1' })
            }
            return Response.json(finalPage)
        },
    })

    assert.deepEqual(requestedUrls, ['https://example.com/page-1', 'https://example.com/page-2'])
    assert.equal(result.complete, true)
    if (result.complete) {
        assert.deepEqual(result.activities.map(({ LogId }) => LogId), ['1', '2'])
        assert.equal(result.nextPollUrl, '/poll-2')
    }
})

test('fetchSaxoOrderActivitiesPages は途中 HTTP failure で partial activities を返さない', async () => {
    let requestCount = 0
    const result = await fetchSaxoOrderActivitiesPages({
        initialUrl: 'https://example.com/page-1',
        fetchPage: async () => {
            requestCount += 1
            return requestCount === 1
                ? Response.json({ Data: [fill()], __next: 'https://example.com/page-2' })
                : new Response('failed', { status: 503 })
        },
    })

    assert.deepEqual(result, { complete: false, reason: 'HTTP_ERROR' })
})

test('fetchSaxoOrderActivitiesPages は不正 payload を parse failure にする', async () => {
    const result = await fetchSaxoOrderActivitiesPages({
        initialUrl: 'https://example.com/page-1',
        fetchPage: async () => Response.json({ Data: [{ LogId: 'missing-required-fields' }] }),
    })

    assert.deepEqual(result, { complete: false, reason: 'PARSE_ERROR' })
})

test('fetchSaxoOrderActivitiesPages は page cap 到達時に partial activities を返さない', async () => {
    const result = await fetchSaxoOrderActivitiesPages({
        initialUrl: 'https://example.com/page-1',
        maxPages: 2,
        fetchPage: async () => Response.json({ Data: [fill()], __next: 'https://example.com/next' }),
    })

    assert.deepEqual(result, { complete: false, reason: 'PAGE_LIMIT' })
})

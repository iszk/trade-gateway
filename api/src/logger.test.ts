import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { serializeLogDetails } from './logger.js'
import { createSaxoSnapshotDiagnosticError } from './brokers/saxo-diagnostics.js'

test('serializeLogDetails: error フィールドの Error を JSON 化できる形にする', () => {
    const error = new Error('firestore failed') as Error & { code?: string }
    error.code = 'invalid-argument'

    const details = serializeLogDetails({ event: 'cron:test', error })

    assert.equal(details.event, 'cron:test')
    assert.deepEqual(details.error, {
        name: 'Error',
        message: 'firestore failed',
        stack: error.stack,
        code: 'invalid-argument',
    })
})

test('serializeLogDetails: 非 Error の error フィールドはそのまま残す', () => {
    const details = serializeLogDetails({ error: { code: 'FORBIDDEN', message: 'denied' } })

    assert.deepEqual(details, {
        error: { code: 'FORBIDDEN', message: 'denied' },
    })
})

test('serializeLogDetails: snapshot diagnostic は cause の秘密値を除き Cloud Logging JSON に保持される', () => {
    const secret = 'token-secret-not-for-logs'
    const cause = new Error(`provider failure ${secret}`, { cause: { token: secret } }) as Error & { code?: string }
    cause.code = secret
    const diagnostic = createSaxoSnapshotDiagnosticError({
        stage: 'balance',
        reason: 'network_error',
        description: 'Failed to fetch Saxo balance',
        operation: 'fetch_balance',
        upstream_path: '/port/v1/balances/me',
        cause,
    })

    const serialized = serializeLogDetails({
        event: 'saxo_portfolio_snapshot:fetch_failed',
        error: diagnostic,
    })
    const json = JSON.stringify(serialized)
    const loggedError = serialized.error as {
        name?: string
        message?: string
        stack?: string
        diagnostic?: { stage?: string; reason?: string; cause_summary?: unknown }
    }

    assert.equal(loggedError.name, 'SaxoSnapshotDiagnosticError')
    assert.equal(loggedError.message, 'Failed to fetch Saxo balance')
    assert.ok(loggedError.stack)
    assert.equal(loggedError.diagnostic?.stage, 'balance')
    assert.equal(loggedError.diagnostic?.reason, 'network_error')
    assert.deepEqual(loggedError.diagnostic?.cause_summary, { name: 'Error' })
    assert.equal(json.includes(secret), false)
})

test('snapshot diagnostic は非 Error throw を値なしで要約する', () => {
    const secret = 'object-token-secret'
    const diagnostic = createSaxoSnapshotDiagnosticError({
        stage: 'snapshot_mapping',
        reason: 'unexpected_error',
        description: 'Failed to map Saxo portfolio snapshot',
        operation: 'map_snapshot',
        cause: { token: secret, payload: { secret } },
    })

    assert.deepEqual(diagnostic.diagnostic.cause_summary, { name: 'NonErrorThrow' })
    assert.equal(JSON.stringify(diagnostic).includes(secret), false)
})

test('Cloud Run transport は snapshot diagnostic の Error を JSON log に保持し秘密値を出さない', () => {
    const script = `
        import { defaultLogger } from './src/logger.ts'
        import { createSaxoSnapshotDiagnosticError } from './src/brokers/saxo-diagnostics.ts'
        const secret = 'cloud-run-secret-not-for-logs'
        const cause = new Error(secret)
        cause.cause = cause
        const error = createSaxoSnapshotDiagnosticError({
            stage: 'net_positions',
            reason: 'invalid_json',
            description: 'Failed to parse Saxo net positions response',
            operation: 'fetch_net_positions',
            upstream_path: '/port/v1/netpositions/me',
            upstream_status: 200,
            cause,
        })
        defaultLogger.error({ event: 'saxo_portfolio_snapshot:fetch_failed', error }, 'snapshot failed')
    `
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: process.cwd(),
        env: { ...process.env, K_SERVICE: 'logger-transport-test' },
        encoding: 'utf8',
    })

    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    const logLine = result.stdout.trim().split('\n').at(-1)
    assert.ok(logLine)
    const output = JSON.parse(logLine) as {
        severity?: string
        message?: string
        event?: string
        error?: { name?: string; message?: string; diagnostic?: { stage?: string; reason?: string; cause_summary?: unknown } }
    }
    assert.equal(output.severity, 'ERROR')
    assert.equal(output.message, 'snapshot failed')
    assert.equal(output.event, 'saxo_portfolio_snapshot:fetch_failed')
    assert.equal(output.error?.name, 'SaxoSnapshotDiagnosticError')
    assert.equal(output.error?.message, 'Failed to parse Saxo net positions response')
    assert.equal(output.error?.diagnostic?.stage, 'net_positions')
    assert.equal(output.error?.diagnostic?.reason, 'invalid_json')
    assert.deepEqual(output.error?.diagnostic?.cause_summary, { name: 'Error' })
    assert.equal(result.stdout.includes('cloud-run-secret-not-for-logs'), false)
})

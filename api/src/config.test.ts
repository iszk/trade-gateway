import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

test('config: Saxo token encryption key を trim して読み込む', async () => {
    const encodedKey = randomBytes(32).toString('base64')
    const previousValue = process.env.SAXO_TOKEN_ENCRYPTION_KEY
    process.env.SAXO_TOKEN_ENCRYPTION_KEY = ` \t${encodedKey}\n`

    try {
        const { config } = await import(`./config.js?config-test=${Date.now()}`)
        assert.equal(config.saxo.tokenEncryptionKey, encodedKey)
    } finally {
        if (previousValue === undefined) {
            delete process.env.SAXO_TOKEN_ENCRYPTION_KEY
        } else {
            process.env.SAXO_TOKEN_ENCRYPTION_KEY = previousValue
        }
    }
})

const loadWebhookFallbackConfig = async (value: string | undefined) => {
    const previousValue = process.env.ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK
    if (value === undefined) {
        delete process.env.ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK
    } else {
        process.env.ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK = value
    }

    try {
        const module = await import(`./config.js?webhook-fallback-test=${Date.now()}-${Math.random()}`)
        return module.config.webhook.allowUnregisteredStrategyPolicyFallback
    } finally {
        if (previousValue === undefined) {
            delete process.env.ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK
        } else {
            process.env.ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK = previousValue
        }
    }
}

test('config: policy fallback は未指定時に true', async () => {
    assert.equal(await loadWebhookFallbackConfig(undefined), true)
})

test('config: policy fallback は true/false を厳密に読む', async () => {
    assert.equal(await loadWebhookFallbackConfig('true'), true)
    assert.equal(await loadWebhookFallbackConfig('false'), false)
})

test('config: policy fallback は不正な値を拒否する', async () => {
    const previousValue = process.env.ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK
    process.env.ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK = '1'

    try {
        await assert.rejects(
            () => import(`./config.js?webhook-fallback-invalid-test=${Date.now()}-${Math.random()}`),
            /ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK must be exactly "true" or "false"/,
        )
    } finally {
        if (previousValue === undefined) {
            delete process.env.ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK
        } else {
            process.env.ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK = previousValue
        }
    }
})

test('config: policy fallback は空白付きの値を受け付けない', async () => {
    const previousValue = process.env.ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK
    process.env.ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK = ' true '

    try {
        await assert.rejects(
            () => import(`./config.js?webhook-fallback-whitespace-test=${Date.now()}-${Math.random()}`),
            /ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK must be exactly "true" or "false"/,
        )
    } finally {
        if (previousValue === undefined) {
            delete process.env.ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK
        } else {
            process.env.ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK = previousValue
        }
    }
})

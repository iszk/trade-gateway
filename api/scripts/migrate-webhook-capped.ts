import { readFile } from 'node:fs/promises'
import { getApps } from 'firebase-admin/app'

import { getFirestoreClient } from '../src/firestore.js'
import { PositionFetcher } from '../src/services/position-fetcher.js'
import {
    runSizingMigration,
    validateSizingMigrationManifest,
    type SizingMigrationManifest,
    type SizingMigrationReport,
} from '../src/services/sizing-migration.js'

type CliOptions = {
    configPath: string
    apply: boolean
    confirmProject?: string
    json: boolean
}

const parseArgs = (argv: string[]): CliOptions => {
    let configPath: string | undefined
    let apply = false
    let confirmProject: string | undefined
    let json = false

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]
        if (arg === '--config') {
            configPath = argv[index + 1]
            index += 1
            continue
        }
        if (arg === '--apply') {
            apply = true
            continue
        }
        if (arg === '--confirm-project') {
            confirmProject = argv[index + 1]
            index += 1
            continue
        }
        if (arg === '--json') {
            json = true
            continue
        }
        throw new Error(`unknown argument: ${arg}`)
    }

    if (!configPath) throw new Error('--config is required')
    if (apply && !confirmProject) throw new Error('--confirm-project is required with --apply')
    if (!apply && confirmProject !== undefined) throw new Error('--confirm-project requires --apply')
    return { configPath, apply, confirmProject, json }
}

const connectedProjectId = (): string | undefined => {
    const appProjectId = getApps()[0]?.options.projectId
    return appProjectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT
}

const printHumanSummary = (report: SizingMigrationReport): void => {
    console.log(`sizing migration ${report.mode.toLowerCase()} project=${report.project_id} writes=${report.writes}`)
    for (const symbol of report.symbols) {
        console.log(`- ${symbol.symbol_id}: ${symbol.status} planned_writes=${symbol.planned_writes} issues=${symbol.issues.length}`)
        for (const item of symbol.issues) {
            console.log(`  issue=${item.reason}${item.strategy_id ? ` strategy=${item.strategy_id}` : ''}${item.order_id ? ` order=${item.order_id}` : ''}`)
        }
        for (const item of symbol.warnings) {
            console.log(`  warning=${item.reason}${item.order_id ? ` order=${item.order_id}` : ''}`)
        }
    }
    for (const item of report.warnings.filter((entry) => !entry.symbol_id)) {
        const details = item.details && typeof item.details === 'object' && 'symbol_id' in item.details
            ? ` symbol=${String(item.details.symbol_id)}`
            : ''
        console.log(`- global warning=${item.reason}${item.order_id ? ` order=${item.order_id}` : ''}${details}`)
    }
    for (const item of report.issues.filter((entry) => !entry.symbol_id)) {
        console.log(`- global issue=${item.reason}${item.order_id ? ` order=${item.order_id}` : ''}`)
    }
    console.log(`blocked=${report.blocked}`)
}

const run = async (): Promise<void> => {
    const options = parseArgs(process.argv.slice(2))
    const configText = await readFile(options.configPath, 'utf8')
    let parsed: unknown
    try {
        parsed = JSON.parse(configText)
    } catch {
        throw new Error('manifest JSON is invalid')
    }
    const manifest = validateSizingMigrationManifest(parsed)
    if (!manifest) throw new Error('manifest is invalid')

    const currentProject = connectedProjectId()
    if (currentProject !== undefined && currentProject !== manifest.project_id) {
        throw new Error(`connected project does not match manifest project: ${currentProject}`)
    }
    if (options.apply && options.confirmProject !== manifest.project_id) {
        throw new Error('--confirm-project does not match manifest project')
    }
    if (options.apply && currentProject === undefined) {
        throw new Error('connected project could not be determined; refusing apply')
    }

    const db = getFirestoreClient()
    const positionFetcher = new PositionFetcher()
    const report = await runSizingMigration({
        db,
        manifest: manifest as SizingMigrationManifest,
        mode: options.apply ? 'APPLY' : 'DRY_RUN',
        positionFetcher,
    })
    if (options.json) console.log(JSON.stringify(report))
    else printHumanSummary(report)
    if (report.blocked) process.exitCode = 1
}

run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`sizing migration failed: ${message}`)
    process.exitCode = 1
})

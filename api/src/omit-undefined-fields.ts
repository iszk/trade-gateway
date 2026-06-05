const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false
    }

    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

const omitUndefined = (value: unknown): unknown => {
    if (value === undefined) {
        return undefined
    }

    if (Array.isArray(value)) {
        return value
            .map((entry) => omitUndefined(entry))
            .filter((entry) => entry !== undefined)
    }

    if (!isPlainObject(value)) {
        return value
    }

    return Object.fromEntries(
        Object.entries(value)
            .map(([key, entryValue]) => [key, omitUndefined(entryValue)] as const)
            .filter(([, entryValue]) => entryValue !== undefined),
    )
}

export const omitUndefinedFields = <T extends Record<string, unknown>>(value: T): T => {
    return omitUndefined(value) as T
}

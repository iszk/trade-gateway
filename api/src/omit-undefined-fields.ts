export const omitUndefinedFields = <T extends Record<string, unknown>>(value: T): T => {
    return Object.fromEntries(
        Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
    ) as T
}

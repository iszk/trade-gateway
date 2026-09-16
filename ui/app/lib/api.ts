type ApiErrorBody = {
  error?: {
    message?: string
  } | string
}

const API_URL = process.env.API_URL || 'http://localhost:3000'
const API_SECRET = process.env.API_SECRET || ''

export type ApiRequestOptions = {
  query?: Record<string, string>
  headers?: Record<string, string>
}

const buildApiUrl = (path: string, query?: Record<string, string>) => {
  const url = new URL(path, API_URL)

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value)
    }
  }

  return url
}

const getErrorMessage = (body: ApiErrorBody) => {
  if (typeof body.error === 'string') {
    return body.error
  }

  return body.error?.message
}

const resolveRequestOptions = (
  queryOrOptions?: Record<string, string> | ApiRequestOptions,
  additionalHeaders?: Record<string, string>,
): ApiRequestOptions => {
  if (!queryOrOptions) {
    return additionalHeaders === undefined ? {} : { headers: additionalHeaders }
  }

  if (Object.hasOwn(queryOrOptions, 'query') || Object.hasOwn(queryOrOptions, 'headers')) {
    const options = queryOrOptions as ApiRequestOptions
    return {
      ...options,
      ...(additionalHeaders === undefined ? {} : {
        headers: { ...options.headers, ...additionalHeaders },
      }),
    }
  }

  return {
    query: queryOrOptions as Record<string, string>,
    ...(additionalHeaders === undefined ? {} : { headers: additionalHeaders }),
  }
}

export const fetchApiJson = async <T>(
  path: string,
  queryOrOptions?: Record<string, string> | ApiRequestOptions,
  additionalHeaders?: Record<string, string>,
): Promise<T> => {
  const options = resolveRequestOptions(queryOrOptions, additionalHeaders)
  const res = await fetch(buildApiUrl(path, options.query), {
    headers: {
      ...options.headers,
      Authorization: `Bearer ${API_SECRET}`,
    },
  })

  if (!res.ok) {
    let message = `Failed to fetch ${path}: ${res.status} ${res.statusText}`
    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const errorBody = (await res.json()) as ApiErrorBody
      const apiMessage = getErrorMessage(errorBody)
      if (apiMessage) {
        message += ` - ${apiMessage}`
      }
    }

    throw new Error(message)
  }

  return await res.json() as T
}

export const sendApiJson = async <T>(
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body: unknown,
  queryOrOptions?: Record<string, string> | ApiRequestOptions,
  additionalHeaders?: Record<string, string>,
): Promise<T> => {
  const options = resolveRequestOptions(queryOrOptions, additionalHeaders)
  const res = await fetch(buildApiUrl(path, options.query), {
    method,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${API_SECRET}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    let message = `Failed to ${method} ${path}: ${res.status} ${res.statusText}`
    const contentType = res.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const errorBody = (await res.json()) as ApiErrorBody
      const apiMessage = getErrorMessage(errorBody)
      if (apiMessage) {
        message += ` - ${apiMessage}`
      }
    }

    throw new Error(message)
  }

  return await res.json() as T
}

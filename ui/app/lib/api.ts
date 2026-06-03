type ApiErrorBody = {
  error?: {
    message?: string
  } | string
}

const API_URL = process.env.API_URL || 'http://localhost:3000'
const API_SECRET = process.env.API_SECRET || ''

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

export const fetchApiJson = async <T>(path: string, query?: Record<string, string>): Promise<T> => {
  const res = await fetch(buildApiUrl(path, query), {
    headers: {
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

export const sendApiJson = async <T>(path: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body: unknown): Promise<T> => {
  const res = await fetch(buildApiUrl(path), {
    method,
    headers: {
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

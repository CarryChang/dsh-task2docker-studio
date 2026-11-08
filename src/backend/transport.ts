/**
 * GraphQL transport for the OpenBayes / HyperAI control plane. Ported from the openbayes-user
 * skill's graphql-core client: it normalizes the bearer token, refuses redirect credential
 * leakage, and returns the bare `data` object so callers never re-peel the envelope.
 * @module dsh-task2docker-studio/backend/transport
 */

import { Task2DockerError, type GraphQLTransport } from './types.ts'

/** Options for the live HTTP transport. */
export interface HttpTransportOptions {
  /** GraphQL endpoint URL, e.g. `https://api.openbayes.com/graphql`. */
  endpoint: string
  /** Access token; a bare token or one already prefixed with `Bearer `. Never logged. */
  token: string
  /** Client self-identification header; lets the platform attribute traffic to this plugin. */
  userAgent?: string
  /** Hard request timeout in milliseconds; a cancelled wait does not roll back a server write. */
  timeoutMs?: number
}

/**
 * Prefix a bare token with the `Bearer ` scheme, leaving an already-prefixed token intact.
 * @param token - raw or prefixed bearer token.
 * @returns the canonical `Bearer <token>` string.
 */
export function normalizeToken(token: string): string {
  return token.startsWith('Bearer ') ? token : `Bearer ${token}`
}

/**
 * Read a field off a nested GraphQL `data` object, failing with an actionable message when the
 * server returned `null` for a mutation — a silent failure, not success.
 * @param data - the bare `data` payload from a transport call.
 * @param path - single top-level field the operation is expected to return.
 * @returns the field value.
 */
export function requireField<T>(data: Record<string, unknown>, path: string): T {
  const value = data[path]
  if (value === null || value === undefined) {
    throw new Task2DockerError(
      `The platform returned no "${path}" and reported no error, which means the request did not take effect. `
      + 'Do not retry with guessed parameters; re-check the account, quota, and catalog selection first.',
    )
  }
  return value as T
}

/** Create a transport that POSTs GraphQL over fetch to the configured endpoint. */
export function createHttpTransport(options: HttpTransportOptions): GraphQLTransport {
  const { endpoint, token, userAgent, timeoutMs = 30_000 } = options
  if (!endpoint) {
    throw new Task2DockerError('No GraphQL endpoint configured. Set endpoint in the plugin config or T2D_ENDPOINT.')
  }
  if (!token) {
    throw new Task2DockerError('No access token configured. Set token in the plugin config or T2D_TOKEN / OPENBAYES_TOKEN.')
  }
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new Task2DockerError(`Endpoint "${endpoint}" is not a valid URL. Re-check the platform endpoint.`)
  }
  const origin = `${url.protocol}//${url.host}`
  const authorization = normalizeToken(token)

  return {
    async execute<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: authorization,
            Origin: origin,
            Referer: `${origin}/`,
            ...(userAgent ? { 'user-agent': userAgent } : {}),
          },
          body: JSON.stringify({ query, variables: variables ?? {} }),
          // Never forward a platform credential through a redirect.
          redirect: 'error',
          signal: controller.signal,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Task2DockerError(`GraphQL request to ${endpoint} failed: ${message}`)
      } finally {
        clearTimeout(timer)
      }

      if (!response.ok) {
        await response.body?.cancel()
        // Upstream error pages can reflect the Authorization header; never echo the body.
        throw new Task2DockerError(`HTTP ${response.status}: the platform rejected the request. Check the token and endpoint.`)
      }

      const payload = (await response.json()) as { data?: Record<string, unknown>; errors?: Array<{ message: string }> }
      if (payload.errors?.length) {
        const first = payload.errors[0]?.message ?? 'unknown GraphQL error'
        throw new Task2DockerError(`GraphQL error: ${first}`)
      }
      if (!payload.data) {
        throw new Task2DockerError('GraphQL response carried neither data nor errors; treat the operation as unconfirmed.')
      }
      return payload.data as T
    },
  }
}

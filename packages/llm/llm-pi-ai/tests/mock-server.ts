import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { zstdDecompressSync } from 'node:zlib'

export interface MockServer {
  url: string
  paths: string[]
  requests: unknown[]
  headers: IncomingMessage['headers'][]
  readonly closedResponses: number
  requestReceived: Promise<void>
  responseClosed: Promise<void>
}

const servers: Server[] = []

/** Close every listener and connection opened since the last call; run from each spec's afterEach. */
export async function closeMockServers(): Promise<void> {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  })))
}

/** A minimal complete text generation in pi-ai's chat-completions shape. */
export const textEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

/** Local provider stand-in: replays scripted behaviors per request. */
export async function mockServer(script: {
  status?: number
  events?: string[]
  body?: string
  delayMs?: number
  /** Keep the SSE response open after its scripted events until the client disconnects. */
  holdOpen?: boolean
  headers?: Record<string, string>
}[]): Promise<MockServer> {
  const paths: string[] = []
  const requests: unknown[] = []
  const headers: IncomingMessage['headers'][] = []
  let closedResponses = 0
  const requestReceived = Promise.withResolvers<undefined>()
  const responseClosed = Promise.withResolvers<undefined>()
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    response.on('close', () => {
      clearTimeout(timer)
      closedResponses += 1
      responseClosed.resolve(undefined)
    })
    const bodyChunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { bodyChunks.push(chunk) })
    request.on('end', () => {
      paths.push(request.url ?? '')
      const body = Buffer.concat(bodyChunks)
      const json = request.headers['content-encoding'] === 'zstd'
        ? zstdDecompressSync(body).toString('utf8')
        : body.toString('utf8')
      requests.push(json.length === 0 ? undefined : JSON.parse(json))
      headers.push(request.headers)
      requestReceived.resolve(undefined)
      const behavior = script.shift() ?? { status: 500, body: 'script exhausted' }
      if (behavior.status !== undefined && behavior.status !== 200) {
        response.writeHead(behavior.status, { 'content-type': 'application/json', ...behavior.headers })
        response.end(behavior.body ?? '{}')
        return
      }
      if (behavior.body !== undefined) {
        response.writeHead(200, { 'content-type': 'application/json', ...behavior.headers })
        response.end(behavior.body)
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.flushHeaders()
      let index = 0
      const writeNext = (): void => {
        const event = behavior.events?.[index++]
        if (event === undefined) {
          if (!behavior.holdOpen) response.end()
          return
        }
        response.write(`data: ${event}\n\n`)
        if (behavior.delayMs === undefined) writeNext()
        else timer = setTimeout(writeNext, behavior.delayMs)
      }
      writeNext()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    paths,
    requests,
    headers,
    requestReceived: requestReceived.promise,
    responseClosed: responseClosed.promise,
    get closedResponses() { return closedResponses },
  }
}

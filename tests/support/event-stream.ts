type StreamOpener = (request: Request) => Response | Promise<Response>

type StreamReader = ReadableStreamDefaultReader<Uint8Array>

const openStreams: AbortController[] = []

export const openTestStream = async (openStream: StreamOpener) => {
  const disconnect = new AbortController()
  openStreams.push(disconnect)
  const response = await openStream(buildStreamRequest(disconnect.signal))
  const reader = response.body!.getReader()
  await readUntil(reader, "retry")
  return { response, reader, disconnect }
}

export const buildStreamRequest = (signal: AbortSignal) => new Request("http://localhost/api/pings/stream", { signal })

export const closeTestStreams = () => {
  openStreams.splice(0).forEach((disconnect) => disconnect.abort())
}

export const readUntil = (reader: StreamReader, field: string) => readMore(reader, field, "")

export const parseEvent = (message: string) => ({
  event: readField(message, "event"),
  payload: JSON.parse(readField(message, "data") ?? "null"),
})

const readMore = async (reader: StreamReader, field: string, received: string): Promise<string> => {
  if (hasWholeMessageWith(received, field)) return received
  const { value, done } = await reader.read()
  if (done) throw new Error(`Stream closed before a "${field}" field arrived. Received: ${received}`)
  return readMore(reader, field, received + textDecoder.decode(value))
}

const hasWholeMessageWith = (received: string, field: string) =>
  readField(received, field) !== undefined && received.endsWith("\n\n")

const readField = (message: string, field: string) => new RegExp(`^${field}: ?(.*)$`, "m").exec(message)?.[1]

const textDecoder = new TextDecoder()

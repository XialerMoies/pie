import { createServer } from "node:http"

const PROTOCOLS = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "mistral-conversations",
  "azure-openai-responses",
  "pi-messages",
])

const TEXT = "fixture text"
const TOOL_NAME = "lookup_weather"
const TOOL_ID = "call12345"
const TOOL_ITEM_ID = "fc_fixture"
const TOOL_ARGUMENTS = '{"city":"Shanghai"}'
const FULL_USAGE = {
  input: 7,
  output: 5,
  cacheRead: 3,
  cacheWrite: 2,
  reasoning: 1,
  totalTokens: 17,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

function headersRecord(headers) {
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => (
    value === undefined ? [] : [[name.toLowerCase(), Array.isArray(value) ? value.join(", ") : value]]
  )))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString("utf8")
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function writeSse(res, chunks) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  for (const chunk of chunks) res.write(chunk)
  res.end()
}

function data(value) {
  return `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`
}

function event(type, value) {
  return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`
}

function openAICompletionChunks() {
  const base = { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: "reasoner-v1" }
  return [
    data({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: TEXT }, finish_reason: null }] }),
    data({
      ...base,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: TOOL_ID,
            type: "function",
            function: { name: TOOL_NAME, arguments: TOOL_ARGUMENTS },
          }],
        },
        finish_reason: null,
      }],
    }),
    data({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 5,
        total_tokens: 17,
        prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    }),
    data("[DONE]"),
  ]
}

function responsesChunks() {
  const messageAdded = {
    id: "msg_fixture",
    type: "message",
    status: "in_progress",
    role: "assistant",
    content: [],
  }
  const messageDone = {
    ...messageAdded,
    status: "completed",
    content: [{ type: "output_text", text: TEXT, annotations: [] }],
  }
  const functionAdded = {
    id: TOOL_ITEM_ID,
    type: "function_call",
    status: "in_progress",
    call_id: TOOL_ID,
    name: TOOL_NAME,
    arguments: "",
  }
  const functionDone = { ...functionAdded, status: "completed", arguments: TOOL_ARGUMENTS }
  const response = {
    id: "resp_fixture",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "reasoner-v1",
    output: [messageDone, functionDone],
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 1 },
    },
  }
  const values = [
    ["response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [] } }],
    ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: messageAdded }],
    ["response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: TEXT }],
    ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: messageDone }],
    ["response.output_item.added", { type: "response.output_item.added", output_index: 1, item: functionAdded }],
    ["response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      item_id: TOOL_ITEM_ID,
      delta: TOOL_ARGUMENTS,
    }],
    ["response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      output_index: 1,
      item_id: TOOL_ITEM_ID,
      arguments: TOOL_ARGUMENTS,
    }],
    ["response.output_item.done", { type: "response.output_item.done", output_index: 1, item: functionDone }],
    ["response.completed", { type: "response.completed", response }],
  ]
  return values.map(([type, value]) => event(type, value))
}

function anthropicChunks() {
  const values = [
    ["message_start", {
      type: "message_start",
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        content: [],
        model: "reasoner-v1",
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 7,
          output_tokens: 0,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      },
    }],
    ["content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: TEXT } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: TOOL_ID, name: TOOL_NAME, input: {} },
    }],
    ["content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: TOOL_ARGUMENTS },
    }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ["message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: {
        input_tokens: 7,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
        output_tokens_details: { thinking_tokens: 1 },
      },
    }],
    ["message_stop", { type: "message_stop" }],
  ]
  return values.map(([type, value]) => event(type, value))
}

function mistralChunks() {
  return [
    data({
      id: "mistral_fixture",
      choices: [{ index: 0, delta: { role: "assistant", content: TEXT }, finish_reason: null }],
    }),
    data({
      id: "mistral_fixture",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: TOOL_ID,
            type: "function",
            function: { name: TOOL_NAME, arguments: TOOL_ARGUMENTS },
          }],
        },
        finish_reason: null,
      }],
    }),
    data({
      id: "mistral_fixture",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 3 },
      },
    }),
    data("[DONE]"),
  ]
}

function piMessagesChunks() {
  return [
    data({ type: "start" }),
    data({ type: "text_start", contentIndex: 0 }),
    data({ type: "text_delta", contentIndex: 0, delta: TEXT }),
    data({ type: "text_end", contentIndex: 0, content: TEXT }),
    data({ type: "toolcall_start", contentIndex: 1, id: TOOL_ID, toolName: TOOL_NAME }),
    data({ type: "toolcall_delta", contentIndex: 1, delta: TOOL_ARGUMENTS }),
    data({
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: { type: "toolCall", id: TOOL_ID, name: TOOL_NAME, arguments: JSON.parse(TOOL_ARGUMENTS) },
    }),
    data({ type: "done", reason: "toolUse", usage: FULL_USAGE, responseId: "pi_fixture" }),
  ]
}

function chunksFor(protocol) {
  if (protocol === "openai-completions") return openAICompletionChunks()
  if (protocol === "openai-responses" || protocol === "azure-openai-responses") return responsesChunks()
  if (protocol === "anthropic-messages") return anthropicChunks()
  if (protocol === "mistral-conversations") return mistralChunks()
  return piMessagesChunks()
}

export async function startFakeModelProvider(protocol, options = {}) {
  if (!PROTOCOLS.has(protocol)) throw new TypeError(`Unsupported fake provider protocol: ${protocol}`)
  const requests = []
  const sockets = new Set()
  let origin
  let requestResolve
  let abortResolve
  const requestPromise = new Promise((resolve) => { requestResolve = resolve })
  const abortPromise = new Promise((resolve) => { abortResolve = resolve })

  const server = createServer(async (req, res) => {
    const record = {
      method: req.method,
      url: new URL(req.url ?? "/", origin).toString(),
      path: new URL(req.url ?? "/", origin).pathname,
      headers: headersRecord(req.headers),
      body: await readBody(req),
      aborted: false,
    }
    requests.push(record)
    requestResolve(record)
    res.on("close", () => {
      if (res.writableEnded) return
      record.aborted = true
      abortResolve(record)
    })

    if (options.holdOpen === true) {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" })
      res.flushHeaders()
      return
    }
    writeSse(res, chunksFor(protocol))
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  origin = `http://127.0.0.1:${address.port}`
  const basePath = protocol === "mistral-conversations"
    ? `/wire/${protocol}`
    : `/wire/${protocol}/v1`

  return {
    origin,
    baseUrl: `${origin}${basePath}`,
    requests,
    waitForRequest: () => requests.length > 0 ? Promise.resolve(requests[0]) : requestPromise,
    waitForAbort: () => requests.some((request) => request.aborted)
      ? Promise.resolve(requests.find((request) => request.aborted))
      : abortPromise,
    async close() {
      for (const socket of sockets) socket.destroy()
      if (!server.listening) return
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

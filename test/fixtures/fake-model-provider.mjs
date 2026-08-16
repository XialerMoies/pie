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
const MODEL_ID = "reasoner-v1"
const EXPECTED_USER_CONTENT = "weather"
const DEFAULT_TIMEOUT_MS = 5_000
const FETCH_BLOCKED_HIGH_PORTS = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6697, 10080,
])
const PATHS = {
  "openai-completions": "/wire/openai-completions/v1/chat/completions",
  "openai-responses": "/wire/openai-responses/v1/responses",
  "anthropic-messages": "/wire/anthropic-messages/v1/messages",
  "mistral-conversations": "/wire/mistral-conversations/v1/chat/completions",
  "azure-openai-responses": "/wire/azure-openai-responses/v1/responses",
  "pi-messages": "/wire/pi-messages/v1/messages",
}
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

function openAICompletionChunks(includeToolCall, modelId) {
  const base = { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: modelId }
  return [
    data({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: TEXT }, finish_reason: null }],
      usage: null,
    }),
    ...(includeToolCall ? [data({
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
      usage: null,
    })] : []),
    data({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: includeToolCall ? "tool_calls" : "stop" }],
      usage: null,
    }),
    data({
      ...base,
      choices: [],
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

function responsesChunks(includeToolCall, modelId) {
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
  const responseBase = {
    id: "resp_fixture",
    object: "response",
    created_at: 1,
    output_text: TEXT,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: modelId,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
  }
  const response = {
    ...responseBase,
    status: "completed",
    output: includeToolCall ? [messageDone, functionDone] : [messageDone],
    usage: {
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
      output_tokens_details: { reasoning_tokens: 1 },
    },
  }
  const values = [
    ["response.created", {
      type: "response.created",
      response: { ...responseBase, output_text: "", status: "in_progress", output: [] },
    }],
    ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: messageAdded }],
    ["response.content_part.added", {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      item_id: messageAdded.id,
      part: { type: "output_text", text: "", annotations: [], logprobs: [] },
    }],
    ["response.output_text.delta", {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: messageAdded.id,
      delta: TEXT,
      logprobs: [],
    }],
    ["response.output_text.done", {
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
      item_id: messageAdded.id,
      text: TEXT,
      logprobs: [],
    }],
    ["response.content_part.done", {
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      item_id: messageAdded.id,
      part: messageDone.content[0],
    }],
    ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: messageDone }],
    ...(includeToolCall ? [
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
      name: TOOL_NAME,
      }],
      ["response.output_item.done", { type: "response.output_item.done", output_index: 1, item: functionDone }],
    ] : []),
    ["response.completed", { type: "response.completed", response }],
  ]
  return values.map(([type, value], sequenceNumber) => event(type, {
    ...value,
    sequence_number: sequenceNumber,
  }))
}

function anthropicChunks(includeToolCall, modelId) {
  const values = [
    ["message_start", {
      type: "message_start",
      message: {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        content: [],
        container: null,
        model: modelId,
        stop_details: null,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          cache_creation: null,
          input_tokens: 7,
          output_tokens: 0,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
          inference_geo: null,
          server_tool_use: null,
          service_tier: null,
        },
      },
    }],
    ["content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: TEXT } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ...(includeToolCall ? [["content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: TOOL_ID, name: TOOL_NAME, input: {}, caller: { type: "direct" } },
    }],
    ["content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: TOOL_ARGUMENTS },
    }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }]] : []),
    ["message_delta", {
      type: "message_delta",
      delta: {
        container: null,
        stop_details: null,
        stop_reason: includeToolCall ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: {
        input_tokens: 7,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
        server_tool_use: null,
        output_tokens_details: { thinking_tokens: 1 },
      },
    }],
    ["message_stop", { type: "message_stop" }],
  ]
  return values.map(([type, value]) => event(type, value))
}

function mistralChunks(includeToolCall, modelId) {
  const base = {
    id: "mistral_fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: modelId,
  }
  return [
    data({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: TEXT }, finish_reason: null }],
    }),
    ...(includeToolCall ? [data({
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
    })] : []),
    data({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: includeToolCall ? "tool_calls" : "stop" }],
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

function piMessagesChunks(includeToolCall) {
  return [
    data({ type: "start" }),
    data({ type: "text_start", contentIndex: 0 }),
    data({ type: "text_delta", contentIndex: 0, delta: TEXT }),
    data({ type: "text_end", contentIndex: 0, content: TEXT }),
    ...(includeToolCall ? [
      data({ type: "toolcall_start", contentIndex: 1, id: TOOL_ID, toolName: TOOL_NAME }),
      data({ type: "toolcall_delta", contentIndex: 1, delta: TOOL_ARGUMENTS }),
      data({
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: { type: "toolCall", id: TOOL_ID, name: TOOL_NAME, arguments: JSON.parse(TOOL_ARGUMENTS) },
      }),
    ] : []),
    data({ type: "done", reason: includeToolCall ? "toolUse" : "stop", usage: FULL_USAGE, responseId: "pi_fixture" }),
  ]
}

function chunksFor(protocol, includeToolCall, modelId) {
  if (protocol === "openai-completions") return openAICompletionChunks(includeToolCall, modelId)
  if (protocol === "openai-responses" || protocol === "azure-openai-responses") {
    return responsesChunks(includeToolCall, modelId)
  }
  if (protocol === "anthropic-messages") return anthropicChunks(includeToolCall, modelId)
  if (protocol === "mistral-conversations") return mistralChunks(includeToolCall, modelId)
  return piMessagesChunks(includeToolCall)
}

function requestTools(protocol, body) {
  return protocol === "pi-messages" ? body?.context?.tools : body?.tools
}

function requestInput(protocol, body) {
  if (protocol === "openai-responses" || protocol === "azure-openai-responses") return body?.input
  if (protocol === "pi-messages") return body?.context?.messages
  return body?.messages
}

function inputContentText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => part?.text ?? "").join("")
}

function inputErrors(protocol, body, expectedUserContent) {
  const input = requestInput(protocol, body)
  if (!Array.isArray(input) || input.length === 0) return ["input must contain at least one message"]
  const user = input.find((message) => message?.role === "user")
  if (!user) return ["input must contain a user message"]
  if (protocol === "openai-responses" || protocol === "azure-openai-responses") {
    if (!Array.isArray(user.content) || !user.content.some((part) => (
      part?.type === "input_text" && part.text === expectedUserContent
    ))) {
      return [`user input must contain input_text=${expectedUserContent}`]
    }
    return []
  }
  return inputContentText(user.content) === expectedUserContent
    ? []
    : [`user content must equal ${expectedUserContent}`]
}

function toolShapeErrors(protocol, tools) {
  if (!Array.isArray(tools) || tools.length === 0) return ["tools must contain at least one definition"]
  const tool = tools.find((entry) => {
    if (protocol === "openai-completions" || protocol === "mistral-conversations") {
      return entry?.type === "function" && entry.function?.name === TOOL_NAME
    }
    return entry?.name === TOOL_NAME && (protocol !== "openai-responses" && protocol !== "azure-openai-responses"
      ? true
      : entry?.type === "function")
  })
  if (!tool) return [`missing ${TOOL_NAME} tool definition`]
  const definition = protocol === "openai-completions" || protocol === "mistral-conversations"
    ? tool.function
    : tool
  const schema = protocol === "anthropic-messages" ? definition.input_schema : definition.parameters
  const errors = []
  if (typeof definition.description !== "string" || definition.description.length === 0) {
    errors.push("tool description must be a non-empty string")
  }
  if (schema?.type !== "object") errors.push("tool schema type must be object")
  if (schema?.properties?.city?.type !== "string") errors.push("tool schema must define city as string")
  if (!Array.isArray(schema?.required) || !schema.required.includes("city")) {
    errors.push("tool schema must require city")
  }
  return errors
}

function validateRequest(protocol, record, requireTools, modelId, expectedUserContent) {
  const url = new URL(record.url)
  if (record.method !== "POST") {
    return { status: 405, stage: "wrong method", details: [`expected POST, received ${record.method}`] }
  }
  if (record.path !== PATHS[protocol]) {
    return { status: 404, stage: "wrong endpoint", details: [`expected ${PATHS[protocol]}, received ${record.path}`] }
  }
  if (protocol === "azure-openai-responses") {
    const versions = url.searchParams.getAll("api-version")
    if (versions.length !== 1 || versions[0] !== "v1" || [...url.searchParams.keys()].length !== 1) {
      return { status: 422, stage: "invalid query", details: ["expected only api-version=v1"] }
    }
  } else if (url.search.length > 0) {
    return { status: 422, stage: "invalid query", details: ["unexpected query parameters"] }
  }
  if (record.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
    return { status: 415, stage: "invalid headers", details: ["content-type must be application/json"] }
  }
  if (protocol === "anthropic-messages" && record.headers["anthropic-version"] !== "2023-06-01") {
    return { status: 400, stage: "invalid headers", details: ["anthropic-version must be 2023-06-01"] }
  }
  if ((protocol === "mistral-conversations" || protocol === "pi-messages")
    && !record.headers.accept?.includes("text/event-stream")) {
    return { status: 400, stage: "invalid headers", details: ["accept must include text/event-stream"] }
  }
  if (record.body === null || typeof record.body !== "object" || Array.isArray(record.body)) {
    return { status: 400, stage: "invalid body", details: ["body must be a JSON object"] }
  }
  if (record.body.model !== modelId || (protocol !== "pi-messages" && record.body.stream !== true)) {
    return {
      status: 422,
      stage: "wrong model/stream",
      details: [`expected model=${modelId}${protocol === "pi-messages" ? "" : " and stream=true"}`],
    }
  }
  if (protocol === "pi-messages" && Object.hasOwn(record.body, "stream")) {
    return { status: 422, stage: "wrong model/stream", details: ["pi-messages streaming is implicit"] }
  }
  const invalidInput = inputErrors(protocol, record.body, expectedUserContent)
  if (invalidInput.length > 0) {
    return { status: 422, stage: "invalid input", details: invalidInput }
  }
  if (protocol === "openai-completions" && record.body.stream_options?.include_usage !== true) {
    return {
      status: 422,
      stage: "invalid stream options",
      details: ["stream_options.include_usage must be true"],
    }
  }
  const tools = requestTools(protocol, record.body)
  if (!Array.isArray(tools) || tools.length === 0) {
    return requireTools
      ? { status: 422, stage: "missing tools", details: ["request must include tools"] }
      : undefined
  }
  const errors = toolShapeErrors(protocol, tools)
  return errors.length === 0 ? undefined : { status: 422, stage: "invalid tools", details: errors }
}

function writeInvalid(res, protocol, invalid) {
  const body = JSON.stringify({
    error: "fixture_request_invalid",
    protocol,
    stage: invalid.stage,
    details: invalid.details,
  })
  res.writeHead(invalid.status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  })
  res.end(body)
}

function boundedWait(promise, protocol, stage, timeoutMs) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${stage} for ${protocol} after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function listenOnFetchSafePort(server) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening)
        reject(error)
      }
      const onListening = () => {
        server.off("error", onError)
        resolve()
      }
      server.once("error", onError)
      server.once("listening", onListening)
      server.listen(0, "127.0.0.1")
    })
    const { port } = server.address()
    if (port >= 1024 && !FETCH_BLOCKED_HIGH_PORTS.has(port)) return port
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
  throw new Error("Unable to allocate a Fetch-safe fixture port after 20 attempts")
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

  const modelId = options.modelId ?? MODEL_ID
  const expectedUserContent = options.expectedUserContent ?? EXPECTED_USER_CONTENT
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

    const invalid = validateRequest(
      protocol,
      record,
      options.requireTools !== false,
      modelId,
      expectedUserContent,
    )
    if (invalid) {
      writeInvalid(res, protocol, invalid)
      return
    }

    if (options.holdOpen === true) {
      res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" })
      res.flushHeaders()
      return
    }
    writeSse(res, chunksFor(protocol, requestTools(protocol, record.body)?.length > 0, modelId))
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  const port = await listenOnFetchSafePort(server)
  origin = `http://127.0.0.1:${port}`
  const basePath = protocol === "mistral-conversations" || protocol === "anthropic-messages"
    ? `/wire/${protocol}`
    : `/wire/${protocol}/v1`
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    origin,
    baseUrl: `${origin}${basePath}`,
    requests,
    waitForRequest: () => boundedWait(
      requests.length > 0 ? Promise.resolve(requests[0]) : requestPromise,
      protocol,
      "request",
      timeoutMs,
    ),
    waitForAbort: () => requests.some((request) => request.aborted)
      ? Promise.resolve(requests.find((request) => request.aborted))
      : boundedWait(abortPromise, protocol, "abort", timeoutMs),
    async close() {
      for (const socket of sockets) socket.destroy()
      if (!server.listening) return
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

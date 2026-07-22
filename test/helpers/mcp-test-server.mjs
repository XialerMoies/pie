/**
 * 最小化 MCP stdio 测试服务器。
 *
 * 实现 MCP 协议子集：initialize / tools/list / tools/call / notifications/initialized
 * 通过 stdio 与 MCP Client 通信。
 *
 * 用法：node test/helpers/mcp-test-server.mjs
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

const tools = [
  {
    name: "greet",
    description: "Greet someone",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name to greet" },
      },
      required: ["name"],
    },
  },
  {
    name: "echo",
    description: "Echo back input",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
      },
    },
  },
];

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // 通知类消息不需要响应
  if (!msg.id) return;

  if (msg.method === "initialize") {
    writeMsg(msg.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "test-server", version: "1.0.0" },
    });
  } else if (msg.method === "tools/list") {
    writeMsg(msg.id, { tools });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params || {};
    if (name === "greet") {
      writeMsg(msg.id, {
        content: [{ type: "text", text: `Hello, ${args?.name ?? "world"}!` }],
      });
    } else if (name === "echo") {
      writeMsg(msg.id, {
        content: [{ type: "text", text: args?.text ?? "" }],
      });
    } else {
      writeMsg(msg.id, {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      });
    }
  }
});

function writeMsg(id, result) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n",
  );
}

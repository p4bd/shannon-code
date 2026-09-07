let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const lineEnd = buffer.indexOf("\n");
    if (lineEnd === -1) {
      return;
    }
    const line = buffer.subarray(0, lineEnd).toString("utf8").trim();
    buffer = buffer.subarray(lineEnd + 1);
    if (line) handleMessage(JSON.parse(line));
  }
});

function handleMessage(message) {
  if (message.method === "notifications/initialized") {
    return;
  }

  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "test-server", version: "1.0.0" },
      },
    });
    return;
  }

  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [
          {
            name: "add",
            description: "Add two numbers",
            inputSchema: {
              type: "object",
              properties: {
                a: { type: "number" },
                b: { type: "number" },
              },
              required: ["a", "b"],
              additionalProperties: false,
            },
          },
          {
            name: "echo",
            description: "Echo text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              additionalProperties: false,
            },
          },
          {
            name: "fail",
            description: "Always fail",
            inputSchema: { type: "object", additionalProperties: true },
          },
          {
            name: "slow",
            description: "Respond slowly",
            inputSchema: { type: "object", additionalProperties: true },
          },
        ],
      },
    });
    return;
  }

  if (message.method === "tools/call") {
    const { name, arguments: args } = message.params;
    if (name === "add") {
      sendText(message.id, String(Number(args.a) + Number(args.b)));
      return;
    }
    if (name === "echo") {
      sendText(message.id, args.text);
      return;
    }
    if (name === "slow") {
      setTimeout(() => sendText(message.id, "late"), 10_000);
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: "Tool failed intentionally" },
    });
  }
}

function sendText(id, text) {
  send({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
    },
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

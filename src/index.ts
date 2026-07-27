// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "my-custom-server",
  version: "1.0.0",
});

server.tool(
  "get_weather",
  "Vráti počasie pre dané mesto",
  { city: z.string().describe("Názov mesta") },
  async ({ city }) => {
    // tu by bola tvoja logika (napr. volanie API)
    return {
      content: [{ type: "text", text: `Počasie v ${city}: 22°C, jasno` }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
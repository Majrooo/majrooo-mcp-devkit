# Project Context: my-mcp-server

## Project Overview

* **Name:** my-mcp-server
* **Description:** A custom MCP (Model Context Protocol) server that provides tools for AI assistants, currently featuring a weather lookup tool.
* **Tech Stack:** Node.js / TypeScript, MCP SDK
* **Package Manager:** npm
* **Dependencies / Requirements:** Defined in `package.json` (MCP SDK, Zod for validation)

## Architecture & Conventions

* **Architecture:** Single-module MCP server using the `@modelcontextprotocol/sdk`. The server registers tools via the `McpServer` class and communicates over stdio using `StdioServerTransport`. Each tool is defined with input validation via Zod schemas.
* **State Management:** N/A (stateless request-response)
* **Styling:** N/A
* **Testing:** None currently configured
* **File Structure:**
  * **`src/`**: Source TypeScript files
      * **`index.ts`**: Main entry point — initializes the MCP server, registers tools, and connects the transport
  * **`build/`**: Compiled JavaScript output (from `tsc`)
      * **`index.js`**: Compiled version of `src/index.ts`
  * **`package.json`**: Project metadata, scripts, and dependencies
  * **`tsconfig.json`**: TypeScript compiler configuration

## Key User Workflows

1. **Weather lookup**: The AI assistant calls the `get_weather` tool with a city name. The server returns a hardcoded weather response (22°C, clear sky). Currently a mock implementation — no real API integration.

## Commands

* **Install:** `npm install`
* **Build:** `npx tsc`
* **Run Dev:** `node build/index.js`
* **Test:** `npm test` (no tests defined)
* **Lint/Format:** Not configured
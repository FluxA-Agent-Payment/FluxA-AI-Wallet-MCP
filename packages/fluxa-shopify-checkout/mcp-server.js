#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ShopifyCheckoutClient } from "./index.js";
import { registerBuyTool } from "./mcp.js";

try {
  const client = ShopifyCheckoutClient.fromEnv();
  const server = new McpServer({ name: "shopify-checkout", version: "0.1.0" });
  registerBuyTool(server, client);
  await server.connect(new StdioServerTransport());
} catch {
  console.error("Could not start Shopify checkout MCP. Check CHECKOUT_SERVICE_URL and CHECKOUT_SERVICE_TOKEN.");
  process.exitCode = 1;
}

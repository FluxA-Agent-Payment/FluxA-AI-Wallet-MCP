import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopifyCheckoutClient } from "./index.js";

export function registerBuyTool(server: McpServer, client: ShopifyCheckoutClient): void;

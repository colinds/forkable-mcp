import { registerMentionTools } from "./mentions.ts";
import { registerProfileTool } from "./profile.ts";
import { registerDeliveryListTool, registerDeliveryStatusTool } from "./deliveries.ts";
import { registerMenuTool, registerSearchTool, registerRecommendationTool } from "./menus.ts";
import {
  registerSetMealTool,
  registerSetAllMealsTool,
  registerRemoveMealTool,
  registerConfirmDeliveryTool,
} from "./meals.ts";
import { registerRatingTool } from "./ratings.ts";
import type { McpServer } from "@modelcontextprotocol/server";
import type { WriteGate } from "../write-gate.ts";

export function registerAllTools(server: McpServer, writeGate: WriteGate): void {
  registerMentionTools(server);
  registerProfileTool(server);
  registerDeliveryListTool(server);
  registerMenuTool(server);
  registerSearchTool(server);
  registerRecommendationTool(server);
  registerDeliveryStatusTool(server);
  registerSetMealTool(server, writeGate);
  registerSetAllMealsTool(server, writeGate);
  registerRemoveMealTool(server, writeGate);
  registerRatingTool(server, writeGate);
  registerConfirmDeliveryTool(server, writeGate);
}

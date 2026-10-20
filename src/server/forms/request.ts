import {
  createElicitInput,
  createOpenAIFormContentSchema,
  OpenAIFormResultSchema,
  requestFormInput,
  type OpenAIFormRequestParams,
} from "@openai/mcp-extensions/server";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

const requestEnvelopeSchema = z.object({
  "io.modelcontextprotocol/protocolVersion": z.string().optional(),
});

const mrtrEnvelopeSchema = z.object({
  "io.modelcontextprotocol/clientCapabilities": z.object({
    elicitation: z.object({ form: z.object({}) }),
    extensions: z.object({ "openai/elicitation": z.object({ form: z.object({}) }) }),
  }),
});

function mealFormTransport(server: McpServer, context: ServerContext) {
  const envelope = requestEnvelopeSchema.safeParse(context.mcpReq.envelope ?? {});
  if (!envelope.success) return undefined;
  const protocol =
    envelope.data["io.modelcontextprotocol/protocolVersion"] ??
    server.server.getNegotiatedProtocolVersion();
  const mrtr = protocol != null && protocol >= "2026-07-28";
  if (mrtr)
    return mrtrEnvelopeSchema.safeParse(context.mcpReq.envelope).success ? "mrtr" : undefined;
  const extensions = server.server.getClientCapabilities()?.extensions;
  if (extensions?.["openai/elicitation"] != null) return "elicitation";
  if (extensions?.["openai/form"] != null) return "form";
  return undefined;
}

export function supportsMealForms(server: McpServer, context: ServerContext): boolean {
  return mealFormTransport(server, context) !== undefined;
}

export async function requestMealForm(
  server: McpServer,
  context: ServerContext,
  { key, requestState, ...params }: OpenAIFormRequestParams & { key: string; requestState: string },
) {
  const transport = mealFormTransport(server, context);
  if (!transport) return undefined;
  if (transport === "mrtr") return requestFormInput(context, { ...params, key, requestState });
  if (transport === "elicitation")
    return createElicitInput(server)(context, params, { timeout: 300000 });

  const { requestedSchema } = params;

  const properties = Object.fromEntries(
    Object.entries(requestedSchema.properties).map(([name, field]) => [
      name,
      "oneOf" in field && field.oneOf && field.oneOf.some((option) => option["x-openai-thumbnail"])
        ? {
            type: "openai/imagePicker",
            title: field.title,
            items: field.oneOf.map((option) => ({
              id: option.const,
              title: [option.title, option.description].filter(Boolean).join(" · "),
              image: option["x-openai-thumbnail"]?.src,
            })),
          }
        : field,
    ]),
  );

  const result = await context.mcpReq.send(
    {
      method: "openai/form",
      params: {
        message: params.message,
        requestedSchema: { ...requestedSchema, properties },
      },
    },
    OpenAIFormResultSchema,
    { timeout: 300000 },
  );
  return result.action === "accept"
    ? {
        ...result,
        content: createOpenAIFormContentSchema(params.requestedSchema).parse(result.content),
      }
    : result;
}

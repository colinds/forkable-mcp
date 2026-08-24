import { describe, expect, test } from "bun:test";
import { MutationError, MutationOutcomeUnknownError } from "@/net/errors.ts";
import {
  createWriteGate,
  hashWriteArgs,
  type GateCtx,
  type ExecutableWritePlan,
  type ToolResultLike,
  type WritePlan,
} from "@/write-gate.ts";

const basePlan: WritePlan = {
  op: "replacePiece",
  selection: "errors piece { id }",
  input: {
    deliveryId: 1,
    oldPieceId: 2,
    menuId: 3,
    itemId: 4,
    selectionsHash: { "10": [100], "11": [-1] },
  },
  summary: "Replace lunch",
  deliveryIds: [1],
  details: { item: "Lunch" },
};

function clonePlan(): WritePlan {
  return structuredClone(basePlan);
}

function context(
  userId = 42,
  execute: GateCtx["execute"] = async (plan) => ({ id: plan.input.itemId }),
  delegationSessionId: string | null = null,
): GateCtx {
  return {
    resolveActor: async () => ({ userId, delegationSessionId }),
    execute,
    buildMutationText: (op, selection) => `mutation ${op} { ${selection} }`,
  };
}

function argsHash(overrides: Record<string, unknown> = {}): string {
  return hashWriteArgs({ deliveryId: 1, itemId: 4, ...overrides });
}

function confirmToken(result: ToolResultLike): string {
  const token = result.structuredContent?.confirmToken;
  if (typeof token !== "string") throw new Error("result has no confirmToken");
  return token;
}

function deterministicGate(options: Parameters<typeof createWriteGate>[0] = {}) {
  let sequence = 0;
  return createWriteGate({
    now: () => 1_000,
    randomToken: () => `token-${++sequence}`,
    ...options,
  });
}

describe("hashWriteArgs", () => {
  test("is stable under object reordering and excludes confirmToken", () => {
    const first = hashWriteArgs({
      deliveryId: 1,
      item: { id: 4, choices: { protein: "tofu", side: "rice" } },
      confirmToken: "first",
    });
    const reordered = hashWriteArgs({
      confirmToken: "second",
      item: { choices: { side: "rice", protein: "tofu" }, id: 4 },
      deliveryId: 1,
    });
    expect(first).toBe(reordered);
    expect(hashWriteArgs({ ids: [1, 2, 3] })).not.toBe(hashWriteArgs({ ids: [3, 2, 1] }));
  });
});

describe("createWriteGate", () => {
  test("valid confirmation executes the stored plan without replanning", async () => {
    const gate = deterministicGate();
    const planned = clonePlan();
    let previewExecutions = 0;
    const preview = await gate(
      context(42, async () => {
        previewExecutions++;
      }),
      { tool: "set_meal", argsHash: argsHash(), plan: async () => planned },
    );
    expect(preview.structuredContent?.mode).toBe("preview");
    expect(confirmToken(preview)).toBe("token-1");
    expect(previewExecutions).toBe(0);
    planned.input.itemId = 999;

    let executed: ExecutableWritePlan | undefined;
    const result = await gate(
      context(42, async (plan) => {
        executed = plan;
        return { pieceId: "new" };
      }),
      {
        tool: "set_meal",
        argsHash: argsHash(),
        confirmToken: confirmToken(preview),
        plan: async () => {
          throw new Error("valid confirmation must not replan");
        },
      },
    );

    expect(result.structuredContent?.mode).toBe("executed");
    expect(executed?.input.itemId).toBe(4);
    expect(executed?.input).toEqual(basePlan.input);
  });

  test("a used token produces a fresh preview instead of executing again", async () => {
    const gate = deterministicGate();
    const preview = await gate(context(), {
      tool: "set_meal",
      argsHash: argsHash(),
      plan: async () => clonePlan(),
    });
    const token = confirmToken(preview);
    await gate(context(), {
      tool: "set_meal",
      argsHash: argsHash(),
      confirmToken: token,
      plan: async () => {
        throw new Error("must not replan");
      },
    });

    let planned = 0;
    const replay = await gate(context(), {
      tool: "set_meal",
      argsHash: argsHash(),
      confirmToken: token,
      plan: async () => {
        planned++;
        return clonePlan();
      },
    });
    expect(planned).toBe(1);
    expect(replay.isError).toBe(true);
    expect(replay.structuredContent?.mode).toBe("preview");
    expect(replay.structuredContent?.confirmationError).toEqual({
      reason: "unknown",
      message: "confirmToken is unknown or has already been used. Here is a fresh preview:",
    });
    expect(confirmToken(replay)).not.toBe(token);
  });

  test("wrong arguments consume the token before validation", async () => {
    const gate = deterministicGate();
    const preview = await gate(context(), {
      tool: "set_meal",
      argsHash: argsHash(),
      plan: async () => clonePlan(),
    });
    const token = confirmToken(preview);

    const mismatch = await gate(context(), {
      tool: "set_meal",
      argsHash: argsHash({ itemId: 5 }),
      confirmToken: token,
      plan: async () => clonePlan(),
    });
    expect(mismatch.isError).toBe(true);
    expect(mismatch.content[0]?.text).toContain("does not match these tool arguments");

    const afterMismatch = await gate(context(), {
      tool: "set_meal",
      argsHash: argsHash(),
      confirmToken: token,
      plan: async () => clonePlan(),
    });
    expect(afterMismatch.content[0]?.text).toContain("unknown or has already been used");
  });

  test("actor, delegation, and tool are part of the pending-write binding", async () => {
    const gate = deterministicGate();
    const actorPreview = await gate(context(42), {
      tool: "set_meal",
      argsHash: argsHash(),
      plan: async () => clonePlan(),
    });
    const wrongActor = await gate(context(43), {
      tool: "set_meal",
      argsHash: argsHash(),
      confirmToken: confirmToken(actorPreview),
      plan: async () => clonePlan(),
    });
    expect(wrongActor.content[0]?.text).toContain("different Forkable user or delegation");

    const delegationPreview = await gate(context(42, undefined, "delegation-a"), {
      tool: "set_meal",
      argsHash: argsHash(),
      plan: async () => clonePlan(),
    });
    const wrongDelegation = await gate(context(42, undefined, "delegation-b"), {
      tool: "set_meal",
      argsHash: argsHash(),
      confirmToken: confirmToken(delegationPreview),
      plan: async () => clonePlan(),
    });
    expect(wrongDelegation.content[0]?.text).toContain("different Forkable user or delegation");

    const toolPreview = await gate(context(42), {
      tool: "set_meal",
      argsHash: argsHash(),
      plan: async () => clonePlan(),
    });
    const wrongTool = await gate(context(42), {
      tool: "remove_meal",
      argsHash: argsHash(),
      confirmToken: confirmToken(toolPreview),
      plan: async () => clonePlan(),
    });
    expect(wrongTool.content[0]?.text).toContain("different tool");
  });

  test("evicts the oldest pending write at the cap", async () => {
    let sequence = 0;
    const gate = createWriteGate({
      maxPending: 1,
      now: () => 1_000,
      randomToken: () => `token-${++sequence}`,
    });
    const first = await gate(context(), {
      tool: "set_meal",
      argsHash: argsHash({ deliveryId: 1 }),
      plan: async () => clonePlan(),
    });
    const second = await gate(context(), {
      tool: "set_meal",
      argsHash: argsHash({ deliveryId: 2 }),
      plan: async () => clonePlan(),
    });
    const evicted = await gate(context(), {
      tool: "set_meal",
      argsHash: argsHash({ deliveryId: 1 }),
      confirmToken: confirmToken(first),
      plan: async () => clonePlan(),
    });
    expect(evicted.content[0]?.text).toContain("unknown");
    expect(confirmToken(second)).toBe("token-2");
  });

  test("reports expiry when the entry is still present", async () => {
    let time = 1_000;
    const gate = deterministicGate({ ttlMs: 100, now: () => time });
    const preview = await gate(context(), {
      tool: "set_meal",
      argsHash: argsHash(),
      plan: async () => clonePlan(),
    });
    time = 1_100;
    const result = await gate(context(), {
      tool: "set_meal",
      argsHash: argsHash(),
      confirmToken: confirmToken(preview),
      plan: async () => clonePlan(),
    });
    expect(result.content[0]?.text).toContain("expired");
  });

  test("blocking guards never issue a token or resolve an actor", async () => {
    let actorResolutions = 0;
    const gate = deterministicGate();
    const ctx = context();
    ctx.resolveActor = async () => {
      actorResolutions++;
      return { userId: 42, delegationSessionId: null };
    };
    const result = await gate(ctx, {
      tool: "set_meal",
      argsHash: argsHash(),
      plan: async () => ({
        ...clonePlan(),
        guards: [{ code: "selection_invalid", level: "block", message: "No write" }],
      }),
    });
    expect(result.structuredContent?.mode).toBe("blocked");
    expect(result.structuredContent).not.toHaveProperty("confirmToken");
    expect(actorResolutions).toBe(0);
  });

  test("maps definite and uncertain mutation failures", async () => {
    const resultFor = async (error: Error): Promise<ToolResultLike> => {
      const gate = deterministicGate();
      const preview = await gate(context(), {
        tool: "set_meal",
        argsHash: argsHash(),
        plan: async () => clonePlan(),
      });
      return gate(
        context(42, async () => {
          throw error;
        }),
        {
          tool: "set_meal",
          argsHash: argsHash(),
          confirmToken: confirmToken(preview),
          plan: async () => {
            throw new Error("must not replan");
          },
        },
      );
    };

    const rejected = await resultFor(
      new MutationError("replacePiece", ["not allowed"], { base: [] }),
    );
    expect(rejected.isError).toBe(true);
    expect(rejected.structuredContent?.mode).toBe("rejected");
    expect(rejected.structuredContent?.errors).toEqual(["not allowed"]);

    const unknown = await resultFor(
      new MutationOutcomeUnknownError("replacePiece", "connection closed", 502),
    );
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent?.mode).toBe("outcome_unknown");
    expect(unknown.structuredContent?.status).toBe(502);
    expect(unknown.structuredContent?.retrySafe).toBe(false);
    expect(unknown.structuredContent?.reconciliation).toEqual({
      tool: "list_deliveries",
      deliveryIds: [1],
    });
  });
});

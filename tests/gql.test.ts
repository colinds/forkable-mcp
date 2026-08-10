import { expect, test, describe } from "bun:test";
import {
  serializeLiteral,
  buildQuery,
  buildMutation,
  inputTypeName,
  assertNameSafe,
} from "../src/net/gql.ts";

describe("serializeLiteral", () => {
  test("scalars", () => {
    expect(serializeLiteral(15194)).toBe("15194");
    expect(serializeLiteral(true)).toBe("true");
    expect(serializeLiteral(null)).toBe("null");
  });

  test("strings are escaped (injection-safe)", () => {
    expect(serializeLiteral('hi "there"')).toBe('"hi \\"there\\""');
    // A malicious attempt to break out of the string stays inside it.
    expect(serializeLiteral('") { evil } #')).toBe('"\\") { evil } #"');
    expect(serializeLiteral("line\nbreak")).toBe('"line\\nbreak"');
  });

  test("arrays preserve order", () => {
    expect(serializeLiteral([1, 2, 3])).toBe("[1, 2, 3]");
    expect(serializeLiteral([])).toBe("[]");
  });

  test("objects use unquoted keys and omit undefined", () => {
    expect(serializeLiteral({ a: 1, b: "x" })).toBe('{ a: 1, b: "x" }');
    expect(serializeLiteral({ a: 1, b: undefined })).toBe("{ a: 1 }");
  });

  test("object keys must be valid GraphQL names", () => {
    // selectionsHash (keyed by numeric modifier ids) is NOT serialized as a literal — it rides
    // in the JSON `$input` variable of a mutation. GraphQL literal object keys can't be numeric,
    // and the serializer correctly refuses them, so a numeric key can never leak into a query.
    expect(() => serializeLiteral({ "10": [100] })).toThrow();
    expect(serializeLiteral({ clubId: 6290 })).toBe("{ clubId: 6290 }");
  });

  test("rejects non-finite numbers", () => {
    expect(() => serializeLiteral(Infinity)).toThrow();
    expect(() => serializeLiteral(NaN)).toThrow();
  });
});

describe("assertNameSafe", () => {
  test("accepts identifiers, rejects junk", () => {
    expect(() => assertNameSafe("menus")).not.toThrow();
    expect(() => assertNameSafe("_x0")).not.toThrow();
    expect(() => assertNameSafe("a-b")).toThrow();
    expect(() => assertNameSafe("1abc")).toThrow();
    expect(() => assertNameSafe("a b")).toThrow();
  });
});

describe("buildQuery", () => {
  test("with args and selection", () => {
    expect(buildQuery("menus", { ids: [15194], clubId: 6290 }, "id name")).toBe(
      "{ menus(ids: [15194], clubId: 6290) { id name } }",
    );
  });

  test("no args", () => {
    expect(buildQuery("me", undefined, "id email")).toBe("{ me { id email } }");
  });

  test("scalar root (no selection)", () => {
    expect(buildQuery("myInProgressDeliveryIds")).toBe("{ myInProgressDeliveryIds }");
  });

  test("extra roots appended", () => {
    expect(buildQuery("me", undefined, "id", ["app { config }"])).toBe(
      "{ me { id } app { config } }",
    );
  });

  test("omits undefined args", () => {
    expect(buildQuery("myDeliveries", { from: "2026-08-10", to: undefined }, "id")).toBe(
      '{ myDeliveries(from: "2026-08-10") { id } }',
    );
  });
});

describe("inputTypeName / buildMutation", () => {
  test("capitalizes first char only", () => {
    expect(inputTypeName("addPiece")).toBe("AddPieceInput");
    expect(inputTypeName("replacePiece")).toBe("ReplacePieceInput");
    expect(inputTypeName("confirmDelivery")).toBe("ConfirmDeliveryInput");
  });

  test("relay wrapper", () => {
    expect(buildMutation("confirmDelivery", "errors delivery { id }")).toBe(
      "mutation ($input: ConfirmDeliveryInput!) { confirmDelivery(input: $input) { errors delivery { id } } }",
    );
  });
});

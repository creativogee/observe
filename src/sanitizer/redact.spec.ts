import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addSensitiveFields,
  matchesSensitiveKey,
  redactLogArgs,
  redactValue,
  resetSensitiveFieldsForTests,
} from "./redact.js";

/**
 * Redaction is opt-in, so each test declares the fields it exercises. This is
 * also how a consuming application configures the package.
 */
const DECLARED_FIELDS = [
  "bvn",
  "nationalId",
  "kraPIN",
  "accountNumber",
  "cardNumber",
  "phoneNumber",
  "email",
  "password",
  "token",
  "auth",
  "nin",
  "secret",
  "dateOfBirth",
  "apiKey",
];

beforeEach(() => {
  addSensitiveFields(DECLARED_FIELDS);
});

afterEach(() => {
  resetSensitiveFieldsForTests();
});

describe("redactValue", () => {
  it("redacts every declared identifier", () => {
    expect(
      redactValue({
        bvn: "22345678901",
        nationalId: "NIN-9921",
        kraPIN: "A001234567Z",
        accountNumber: "0123456789",
        cardNumber: "4111111111111111",
        phoneNumber: "+2348012345678",
        email: "driver@example.com",
      }),
    ).toEqual({
      bvn: "[REDACTED]",
      nationalId: "[REDACTED]",
      kraPIN: "[REDACTED]",
      accountNumber: "[REDACTED]",
      cardNumber: "[REDACTED]",
      phoneNumber: "[REDACTED]",
      email: "[REDACTED]",
    });
  });

  it("keeps the fields an on-call engineer needs", () => {
    expect(
      redactValue({ orderId: "ORD_01H", status: "FAILED", attempt: 3 }),
    ).toEqual({ orderId: "ORD_01H", status: "FAILED", attempt: 3 });
  });

  it("treats every spelling of a name as the same field", () => {
    for (const key of [
      "accountNumber",
      "account_number",
      "ACCOUNT_NUMBER",
      "account-number",
      "AccountNumber",
    ]) {
      expect(matchesSensitiveKey(key), key).toBe(true);
    }
  });

  it("catches the snake_case spellings the substring matcher missed", () => {
    // `"account_number".includes("accountnumber")` is false, so the inherited
    // matcher let every snake_case and kebab-case identifier through.
    expect(
      redactValue({
        national_id: "NIN-1",
        "card-number": "4111111111111111",
        DATE_OF_BIRTH: "1990-01-01",
        api_key: "k",
      }),
    ).toEqual({
      national_id: "[REDACTED]",
      "card-number": "[REDACTED]",
      DATE_OF_BIRTH: "[REDACTED]",
      api_key: "[REDACTED]",
    });
  });

  it("does not redact words that merely contain a sensitive fragment", () => {
    // `pin` inside `shipping`, `key` inside `monkeyCount` and `keyboard`.
    for (const key of [
      "shipping",
      "shippingMethod",
      "monkeyCount",
      "keyboard",
    ]) {
      expect(matchesSensitiveKey(key), key).toBe(false);
    }
  });

  it("still matches short identifiers as standalone tokens", () => {
    expect(matchesSensitiveKey("nin")).toBe(true);
    expect(matchesSensitiveKey("customerNIN")).toBe(true);
    expect(matchesSensitiveKey("running")).toBe(false);
  });

  it("splits acronyms so kraPIN is both kra and pin", () => {
    expect(matchesSensitiveKey("kraPIN")).toBe(true);
    expect(matchesSensitiveKey("customer_kra_pin")).toBe(true);
  });

  it("matches on substrings, so derived names are covered too", () => {
    expect(
      redactValue({ accessToken: "a", refreshToken: "b", bvnNumber: "c" }),
    ).toEqual({
      accessToken: "[REDACTED]",
      refreshToken: "[REDACTED]",
      bvnNumber: "[REDACTED]",
    });
  });

  it("redacts through nesting and arrays", () => {
    expect(
      redactValue({
        customers: [{ name: "a", bvn: "1" }, { bvn: "2" }],
        meta: { requestId: "req-1", password: "p" },
      }),
    ).toEqual({
      customers: [{ name: "a", bvn: "[REDACTED]" }, { bvn: "[REDACTED]" }],
      meta: { requestId: "req-1", password: "[REDACTED]" },
    });
  });

  it("collapses a whole subtree when the branch key is itself sensitive", () => {
    // `auth` is a sensitive key, so nothing under it is walked or emitted -
    // stronger than redacting leaf by leaf, and it means a newly added secret
    // inside `auth` is covered without touching the field list.
    expect(redactValue({ auth: { token: "t", scheme: "bearer" } })).toEqual({
      auth: "[REDACTED]",
    });
  });

  it("survives a circular payload", () => {
    const node: Record<string, unknown> = { bvn: "1" };
    node.self = node;
    expect(redactValue(node)).toEqual({
      bvn: "[REDACTED]",
      self: "[Circular]",
    });
  });

  it("redacts the same object twice rather than calling it circular", () => {
    const shared = { bvn: "1" };
    expect(redactValue({ a: shared, b: shared })).toEqual({
      a: { bvn: "[REDACTED]" },
      b: { bvn: "[REDACTED]" },
    });
  });

  it("stops at a depth bound", () => {
    let deep: Record<string, unknown> = { bvn: "leaf" };
    for (let i = 0; i < 12; i += 1) {
      deep = { nested: deep };
    }
    expect(JSON.stringify(redactValue(deep))).toContain("[MaxDepth]");
  });

  it("collapses buffers and large numeric arrays", () => {
    expect(redactValue({ blob: Buffer.from("hi") })).toEqual({
      blob: "[Buffer]",
    });
    expect(
      redactValue({ bytes: Array.from({ length: 101 }, () => 1) }),
    ).toEqual({ bytes: "[Binary Data]" });
  });

  it("keeps an error readable while redacting its payload", () => {
    const error = Object.assign(new Error("request failed"), {
      response: { data: { bvn: "22345678901", orderId: "ORD_1" } },
    });
    const redacted = redactValue(error) as Record<string, unknown>;

    expect(redacted.name).toBe("Error");
    expect(redacted.message).toBe("request failed");
    expect(typeof redacted.stack).toBe("string");
    expect(redacted.response).toEqual({
      data: { bvn: "[REDACTED]", orderId: "ORD_1" },
    });
  });

  it("passes primitives through untouched", () => {
    expect(redactLogArgs(["order failed", 42, null, undefined])).toEqual([
      "order failed",
      42,
      null,
      undefined,
    ]);
  });

  it("cannot redact a value already interpolated into a string", () => {
    // Documents the boundary rather than pretending it is covered: once a BVN
    // is inside a template literal there is no key left to match.
    expect(redactLogArgs([`bvn 22345678901 rejected`])).toEqual([
      "bvn 22345678901 rejected",
    ]);
  });

  it("accepts service-specific fields in any spelling", () => {
    addSensitiveFields(["loan_reference"]);
    expect(
      redactValue({
        loanReference: "L-1",
        loan_reference: "L-2",
        orderId: "O-1",
      }),
    ).toEqual({
      loanReference: "[REDACTED]",
      loan_reference: "[REDACTED]",
      orderId: "O-1",
    });
  });
});

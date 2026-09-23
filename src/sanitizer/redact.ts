/**
 * Splits a field name into lowercase word tokens, so every spelling of the
 * same name collapses to one form: `accessToken`, `access_token`,
 * `ACCESS_TOKEN` and `access-token` all become `["access", "token"]`.
 */
export function tokenizeKey(key: string): string[] {
  return (
    key
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      // Closes an acronym run before the next word: `kraPIN` -> `kra PIN`,
      // `XMLHttpRequest` -> `XML Http Request`.
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[^a-zA-Z0-9]+/)
      .filter((token) => token.length > 0)
      .map((token) => token.toLowerCase())
  );
}

const REDACTION_MARKER = "[REDACTED]";

/** Bounds the walk so a deeply nested payload cannot stall a log call. */
const MAX_DEPTH = 8;

/** Arrays longer than this made only of numbers are treated as binary. */
const BINARY_ARRAY_LENGTH = 100;

const SKIPPED_KEYS = new Set(["rawheaders", "rawtrailers", "socket"]);

/**
 * Empty until the integrator declares what is sensitive.
 *
 * There is no default list on purpose. What must not reach a telemetry
 * backend depends on the jurisdiction and the domain, and a shipped opinion
 * would be wrong for most consumers while looking like coverage. Redaction is
 * therefore opt-in: call `addSensitiveFields()` during bootstrap, before the
 * first log record is exported.
 */
let sensitiveFields = new Set<string>();

/**
 * Declares field names to redact from exported logs.
 *
 * Nothing is redacted until this is called. Names are canonicalized on the
 * way in, so passing `loan_reference` also covers `loanReference` and
 * `LOAN_REFERENCE`.
 */
export function addSensitiveFields(fields: readonly string[]): void {
  for (const field of fields) {
    sensitiveFields.add(tokenizeKey(field).join(""));
  }
}

/**
 * Replaces the field list outright, discarding anything already declared.
 *
 * Useful when configuration is rebuilt rather than accumulated. Passing an
 * empty array turns redaction off.
 */
export function setSensitiveFields(fields: readonly string[]): void {
  sensitiveFields = new Set<string>(
    fields.map((field) => tokenizeKey(field).join("")),
  );
}

/**
 * Whether any field has been declared. Used to warn once when log export is
 * on but nothing is configured, since the failure mode is otherwise silent.
 */
export function hasSensitiveFields(): boolean {
  return sensitiveFields.size > 0;
}

/** Clears the field list — tests only. */
export function resetSensitiveFieldsForTests(): void {
  sensitiveFields = new Set<string>();
}

/**
 * Whether a key names something sensitive.
 *
 * Matching is on whole word tokens, not raw substrings. A plain
 * `key.toLowerCase().includes(field)` - what this replaces - is wrong in both
 * directions: it misses `account_number` (the separator breaks the run) while
 * redacting `shipping` and `monkeyCount` (which contain `pin` and `key`).
 *
 * Every contiguous run of the key's tokens is tested, so `token` still matches
 * `accessToken`, and `accountnumber` matches `account_number`, while a short
 * entry like `pin` or `nin` only matches a standalone token.
 */
export function matchesSensitiveKey(key: string): boolean {
  const tokens = tokenizeKey(key);
  for (let start = 0; start < tokens.length; start += 1) {
    let run = "";
    for (let end = start; end < tokens.length; end += 1) {
      run += tokens[end];
      if (sensitiveFields.has(run)) {
        return true;
      }
    }
  }
  return false;
}

function isBuffer(value: object): boolean {
  return typeof Buffer !== "undefined" && Buffer.isBuffer(value);
}

/**
 * Redacts sensitive values from one log argument.
 *
 * Key-based, so it only sees structured data. A value already interpolated
 * into a string - `` console.error(`bvn ${bvn}`) `` - has no key left to match
 * and passes through untouched. That limit is inherited from the Sentry
 * sanitizer this replaces; structured logging is what makes redaction work.
 */
export function redactValue(value: unknown): unknown {
  return redact(value, new Set<object>(), 0);
}

/** Redacts every argument of a log call, preserving arity and order. */
export function redactLogArgs(args: readonly unknown[]): unknown[] {
  return args.map((arg) => redactValue(arg));
}

function redact(value: unknown, seen: Set<object>, depth: number): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth > MAX_DEPTH) {
    return "[MaxDepth]";
  }
  if (isBuffer(value)) {
    return "[Buffer]";
  }
  if (value instanceof Date || value instanceof RegExp) {
    return value;
  }
  // Added before the recursion and removed after, so a genuine cycle is caught
  // while the same object appearing twice in a tree is still redacted twice.
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  try {
    if (value instanceof Error) {
      return redactError(value, seen, depth);
    }
    if (Array.isArray(value)) {
      return redactArray(value, seen, depth);
    }
    return redactObject(value as Record<string, unknown>, seen, depth);
  } finally {
    seen.delete(value);
  }
}

/**
 * Errors become plain objects carrying their own properties, which is what
 * lets an Axios error's `response.data` be redacted at all. `message` and
 * `stack` are preserved verbatim so the exported record still reads like an
 * error rather than an opaque object.
 */
function redactError(
  error: Error,
  seen: Set<object>,
  depth: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  };
  if (error.stack !== undefined) {
    result.stack = error.stack;
  }
  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === "name" || key === "message" || key === "stack") {
      continue;
    }
    result[key] = redactProperty(
      key,
      (error as unknown as Record<string, unknown>)[key],
      seen,
      depth,
    );
  }
  return result;
}

function redactArray(
  values: unknown[],
  seen: Set<object>,
  depth: number,
): unknown {
  if (
    values.length > BINARY_ARRAY_LENGTH &&
    values.every((item) => typeof item === "number")
  ) {
    return "[Binary Data]";
  }
  return values.map((item) => redact(item, seen, depth + 1));
}

function redactObject(
  value: Record<string, unknown>,
  seen: Set<object>,
  depth: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = redactProperty(key, item, seen, depth);
  }
  return result;
}

function redactProperty(
  key: string,
  value: unknown,
  seen: Set<object>,
  depth: number,
): unknown {
  if (SKIPPED_KEYS.has(key.toLowerCase())) {
    return "[Skipped]";
  }
  if (matchesSensitiveKey(key)) {
    return REDACTION_MARKER;
  }
  return redact(value, seen, depth + 1);
}

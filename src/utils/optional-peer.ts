import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** `installed: true` with no `module` means present but unloadable; `error` carries why. */
export type OptionalPeerResult<T> =
  | { installed: false }
  | { installed: true; module: T | undefined; error?: unknown };

/** Names a load failure for a log line: the message for an `Error`, `String` otherwise. */
export function describePeerLoadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type RequireFn = ReturnType<typeof createRequire>;

const requireCache = new Map<string, RequireFn | undefined>();

/**
 * Where to start resolving an optional peer from.
 *
 * Optional peers are the *host application's* dependencies, never this
 * package's, so resolution starts at the application. Starting at this file
 * instead would break under pnpm's strict layout, where this package's
 * directory can only see packages it declared itself - `pg`, `ioredis` and
 * `@nestjs/microservices` are the application's, and would all read as "not
 * installed".
 *
 * `process.argv[1]` is the entry script. `process.cwd()` is the fallback, and
 * is the same root `resolveConfig()` already reads `package.json` from.
 */
function resolutionBases(): string[] {
  const bases: string[] = [];
  const entry = process.argv[1];
  if (typeof entry === "string" && entry.length > 0) {
    bases.push(entry);
  }
  bases.push(join(process.cwd(), "package.json"));
  return bases;
}

function requireFrom(base: string): RequireFn | undefined {
  if (requireCache.has(base)) {
    return requireCache.get(base);
  }
  let created: RequireFn | undefined;
  try {
    created = createRequire(base);
  } catch {
    created = undefined;
  }
  requireCache.set(base, created);
  return created;
}

/** The first base that can resolve `packageName`, or `undefined` if none can. */
function resolveFrom(packageName: string): RequireFn | undefined {
  for (const base of resolutionBases()) {
    const require = requireFrom(base);
    if (!require) {
      continue;
    }
    try {
      require.resolve(packageName);
      return require;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Loads an optional peer without a static import. Synchronous on purpose:
 * callers patch during construction or `onModuleInit`, before the peer's own
 * lifecycle runs, and `import()` would resolve too late.
 *
 * Presence is probed via `require.resolve(packageName)` before `specifier`
 * (which may be a deep path) is required, so "not installed" stays distinct
 * from "installed but broken". Pass `{ probeOnly: true }` to stop after the
 * resolve - `@grpc/grpc-js` must not load until `sdk.start()` has registered
 * GrpcInstrumentation.
 */
export function loadOptionalPeer<T>(
  packageName: string,
  specifier: string = packageName,
  options?: { probeOnly?: boolean },
): OptionalPeerResult<T> {
  const require = resolveFrom(packageName);
  if (!require) {
    return { installed: false };
  }
  if (options?.probeOnly) {
    return { installed: true, module: undefined };
  }
  try {
    return { installed: true, module: require(specifier) as T };
  } catch (error) {
    const withinPackage = resolveWithinPackage(require, packageName, specifier);
    if (withinPackage) {
      try {
        return { installed: true, module: require(withinPackage) as T };
      } catch {
        // Report the original failure - it names the specifier actually requested.
      }
    }
    return { installed: true, module: undefined, error };
  }
}

/** Bypasses an `exports` map that hides a deep subpath, via the package's own `package.json`. */
function resolveWithinPackage(
  require: RequireFn,
  packageName: string,
  specifier: string,
): string | undefined {
  const prefix = `${packageName}/`;
  if (!specifier.startsWith(prefix)) {
    return undefined;
  }
  try {
    const manifest = require.resolve(`${packageName}/package.json`);
    return join(dirname(manifest), specifier.slice(prefix.length));
  } catch {
    return undefined;
  }
}

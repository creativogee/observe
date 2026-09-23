export const DEFAULT_HTTP_IGNORE_PATHS = [
  "/health",
  "/healthz",
  "/metrics",
  "/ready",
  "/live",
] as const;

export function httpPathname(url: string): string {
  const withoutHash = (url.split("#")[0] ?? url).split("?")[0] ?? url;
  return withoutHash || "/";
}

function matchesPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isIgnoredHttpPath(
  url: string,
  ignorePaths: ReadonlyArray<string | RegExp> = DEFAULT_HTTP_IGNORE_PATHS,
): boolean {
  const pathname = httpPathname(url);
  return ignorePaths.some((item) => {
    if (typeof item === "string") {
      return matchesPathPrefix(pathname, item);
    }
    return item.test(pathname);
  });
}

export function shouldIgnoreHttpRequest(
  req: { url: string; method: string },
  ignore?:
    | Array<string | RegExp>
    | ((req: { url: string; method: string }) => boolean),
): boolean {
  if (isIgnoredHttpPath(req.url)) {
    return true;
  }
  if (typeof ignore === "function") {
    return ignore(req);
  }
  if (Array.isArray(ignore)) {
    return isIgnoredHttpPath(req.url, ignore);
  }
  return false;
}

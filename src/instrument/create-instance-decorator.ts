import { context, SpanStatusCode, trace } from "@opentelemetry/api";

/** Stand-in class name for standalone functions, which have no enclosing class. */
const STANDALONE_FUNCTION_LABEL = "Function";

type AnyFunction = (...args: never[]) => unknown;

interface TracedCallSpec {
  className: string;
  methodName: string;

  /** Re-entrancy guard: nested calls to the same callable run untraced. */
  isActive: () => boolean;
  setActive: (active: boolean) => void;

  call: (thisArg: unknown, args: unknown[]) => unknown;
  callUntraced: (thisArg: unknown, args: unknown[]) => unknown;
}

function withSpan<T>(className: string, methodName: string, fn: () => T): T {
  const parent = trace.getSpan(context.active());
  if (!parent) {
    return fn();
  }
  // Resolved per-call so tests can swap the global provider between cases,
  // and so an SDK start after this module's first import still takes effect.
  const tracer = trace.getTracer("@crudmates/observe");
  return tracer.startActiveSpan(`${className}.${methodName}`, (span) => {
    try {
      const result = fn();
      if (result instanceof Promise) {
        return result.then(
          (value) => {
            span.end();
            return value;
          },
          (err) => {
            span.recordException(err);
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
            throw err;
          },
        ) as T;
      }
      span.end();
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      throw err;
    }
  });
}

export function createInstanceDecorator(options: {
  skipInstrumentation: (instance: unknown) => boolean;
}): (instance: unknown) => unknown {
  /** Wrapper shared by methods and standalone functions, named `<className>.<methodName>`. */
  const createTracedWrapper = (spec: TracedCallSpec) => {
    const { className, methodName } = spec;
    const frameName = `${className}.${methodName}`;

    // Pulled out of `spec` so they run as plain functions: `spec.call(...)`
    // would make `spec` the frame's receiver and print "Object.<name>".
    const call = spec.call;
    const callUntraced = spec.callUntraced;

    // A function expression, not an arrow: it must forward whatever `this`
    // the caller invoked it with.
    return named(frameName, function (this: unknown, ...args: unknown[]) {
      if (spec.isActive()) {
        return callUntraced(this, args);
      }

      spec.setActive(true);
      try {
        return withSpan(className, methodName, () => {
          try {
            const result = call(this, args);
            if (result instanceof Promise) {
              return result.then(
                (value) => value,
                (err) => {
                  relabelProxyFrame(err, className, methodName);
                  throw err;
                },
              );
            }
            return result;
          } catch (err) {
            relabelProxyFrame(err, className, methodName);
            throw err;
          }
        });
      } finally {
        spec.setActive(false);
      }
    });
  };

  const instrumentFunction = (fn: AnyFunction) => {
    // Classes are functions too, but calling one constructs - it's not the
    // kind of call this decorator traces.
    if (isClass(fn) || options.skipInstrumentation(fn)) {
      return fn;
    }

    const methodName = fn.name || "anonymous";
    const className = STANDALONE_FUNCTION_LABEL;
    const frameName = `${className}.${methodName}`;
    let active = false;

    const invoke = named(frameName, (thisArg: unknown, args: unknown[]) =>
      Reflect.apply(fn, thisArg, args),
    );
    const tracedFn = createTracedWrapper({
      className,
      methodName,
      isActive: () => active,
      setActive: (value) => (active = value),
      call: invoke,
      callUntraced: invoke,
    });

    // Proxying the function, rather than handing back the wrapper, keeps
    // `name`/`length`/`prototype`/statics/`instanceof` intact for free. Only
    // `apply` is trapped, so `new fn()` still constructs the original.
    return new Proxy(fn, {
      apply: named(frameName, (_target, thisArg, args) =>
        Reflect.apply(tracedFn, thisArg, args),
      ),
    });
  };

  const instrumentObject = (instance: object) => {
    if (options.skipInstrumentation(instance)) {
      return instance;
    }

    // Native private members (`this.#x`) brand-check the receiver, which a
    // proxy fails ("Receiver must be an instance of class"). Built-ins backed
    // by internal slots (`Map`, `Set`, `Date`, ...) fail the same way -
    // `Map.prototype.has` reads `[[MapData]]` off its receiver, and internal
    // slots never forward through a proxy ("called on incompatible receiver",
    // nestjs/nest#17569). Both cases fall back to the raw instance as
    // receiver, trading nested `this.other()` spans for methods that run.
    let hasPrivateMembers: boolean;
    let slotBacked: boolean;
    let bareBuiltIn: boolean;
    try {
      hasPrivateMembers = usesNativePrivateMembers(instance);
      slotBacked = isSlotBackedBuiltIn(instance);
      bareBuiltIn = slotBacked && isNativeFunction(instance.constructor);
    } catch {
      // A prototype read threw (nestjs-cls proxy providers do this outside a
      // CLS context) - can't inspect it, can't instrument it.
      return instance;
    }

    // A bare built-in provider (`useValue: new Map()`) has no user code to
    // trace - every method is native and would throw through the proxy. A
    // user *subclass* of a built-in still has methods worth tracing, so only
    // the bare case is handed back untouched.
    if (bareBuiltIn) {
      return instance;
    }

    const requiresRawReceiver = hasPrivateMembers || slotBacked;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    const methodRefsCache = new WeakMap<object, Function>();
    const currentlyTracing = new WeakMap<object, Set<string>>();
    return new Proxy(instance, {
      get: (target, prop, receiver) => {
        const attributeValue = Reflect.get(target, prop);
        const isFunction =
          typeof attributeValue === "function" && prop !== "constructor";

        const shouldProxy =
          isFunction &&
          !isClass(attributeValue) &&
          // A callable *object* (a Mongoose model, an Axios instance, an
          // EventEmitter-backed client) is a field, not a method: the traced
          // wrapper is a fresh bound function, so wrapping one silently drops
          // everything hanging off it.
          !isCallableObject(attributeValue);
        if (!shouldProxy) {
          return Reflect.get(target, prop);
        }

        const className = target.constructor.name;
        const methodName = String(prop);
        const frameName = `${className}.${methodName}`;

        if (methodRefsCache.has(attributeValue)) {
          return methodRefsCache.get(attributeValue);
        }

        // For a private-member class, `Reflect.get` with the proxy as
        // receiver would already throw, so the target-fetched value above is
        // reused instead.
        const originalMethod = requiresRawReceiver
          ? attributeValue
          : Reflect.get(target, prop, receiver);
        const tracedReceiver = requiresRawReceiver ? target : receiver;
        const proxyFn = createTracedWrapper({
          className,
          methodName,
          isActive: () =>
            currentlyTracing.get(target)?.has(methodName) ?? false,
          setActive: (active) => {
            if (!currentlyTracing.has(target)) {
              currentlyTracing.set(target, new Set());
            }
            const activeMethods = currentlyTracing.get(target)!;
            if (active) {
              activeMethods.add(methodName);
            } else {
              activeMethods.delete(methodName);
            }
          },
          // Runs against the proxy so `this.other()` is instrumented as a
          // nested step - except for private-member classes, whose brand
          // check only the raw instance satisfies.
          call: named(frameName, (_thisArg, args) =>
            originalMethod.apply(tracedReceiver, args),
          ),
          callUntraced: named(frameName, (_thisArg, args) =>
            originalMethod.apply(target, args),
          ),
        });

        // V8 hard-codes a stack frame's type name to "Proxy" whenever its
        // receiver is a proxy, and no trap can override that. The wrapper
        // never reads `this`, so detaching the receiver costs nothing and
        // makes V8 print "<Class>.<method>" on its own.
        const boundFn = proxyFn.bind(undefined);

        // `bind` renames to "bound <name>" and drops metadata; restore both
        // so the wrapper stays indistinguishable to DI/decorators/arity checks.
        Object.defineProperty(boundFn, "name", {
          value: originalMethod.name,
          configurable: true,
        });
        copyReflectMetadata(originalMethod, boundFn);

        methodRefsCache.set(attributeValue, boundFn);
        return boundFn;
      },
    });
  };

  return (instance: unknown) => {
    if (typeof instance === "function") {
      return instrumentFunction(instance as AnyFunction);
    }
    if (typeof instance === "object" && instance) {
      return instrumentObject(instance);
    }
    return instance;
  };
}

/** Redefines `name` so V8's stack serializer prints it for this function's frames. */
function named<T extends AnyFunction>(name: string, fn: T): T {
  Object.defineProperty(fn, "name", { value: name, configurable: true });
  return fn;
}

/**
 * Rewrites a `Proxy.<method>` stack frame into `<Class>.<method>`.
 *
 * Traced calls run against the proxy on purpose (so `this.other()` is picked
 * up as a nested step), so the *original* method's own frame prints as
 * `Proxy.<method>` - the wrapper frames around it are already named after the
 * class. Only the topmost match is rewritten; inner calls unwind before outer
 * ones, so two classes sharing a method name each get the right label.
 */
function relabelProxyFrame(
  err: unknown,
  className: string,
  methodName: string,
): void {
  if (!(err instanceof Error) || typeof err.stack !== "string") {
    return;
  }
  // `async` prefixes the type name on frames resumed from an await.
  const frame = new RegExp(
    String.raw`(\n\s*at (?:async )?)Proxy\.${escapeRegExp(methodName)}\b`,
  );
  if (!frame.test(err.stack)) {
    return;
  }
  try {
    err.stack = err.stack.replace(frame, `$1${className}.${methodName}`);
  } catch {
    // Some errors ship a read-only `stack`; the label is cosmetic.
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function isClass(value: AnyFunction): boolean {
  return /^\s*class\s+/.test(value.toString());
}

/** Prototypes every ordinary function (plain, async, generator, arrow, bound) hangs off. */
const INTRINSIC_FUNCTION_PROTOTYPES = new Set<object | null>([
  Function.prototype,
  Object.getPrototypeOf(async function () {}),
  Object.getPrototypeOf(function* () {}),
  Object.getPrototypeOf(async function* () {}),
]);

/**
 * Whether a function is really an object with a call signature (a Mongoose
 * model, a client with methods hung directly on it) rather than a method to
 * trace: a non-intrinsic prototype (Mongoose sets `M.__proto__ = Model`) or
 * own enumerable properties (statics), either of which a plain method never
 * carries.
 */
function isCallableObject(fn: AnyFunction): boolean {
  return (
    !INTRINSIC_FUNCTION_PROTOTYPES.has(Object.getPrototypeOf(fn)) ||
    Object.keys(fn).length > 0
  );
}

/**
 * Prototypes of built-ins whose methods read internal slots off their
 * receiver, which never forward through a proxy. `%TypedArray%.prototype`
 * (via `Uint8Array`'s parent) covers `Buffer` too. `Array` is deliberately
 * absent - its methods are generic and proxy-safe.
 */
const SLOT_BACKED_PROTOTYPES = new Set<object>([
  Map.prototype,
  Set.prototype,
  WeakMap.prototype,
  WeakSet.prototype,
  Date.prototype,
  RegExp.prototype,
  Promise.prototype,
  ArrayBuffer.prototype,
  ...(typeof SharedArrayBuffer === "undefined"
    ? []
    : [SharedArrayBuffer.prototype]),
  DataView.prototype,
  WeakRef.prototype,
  FinalizationRegistry.prototype,
  Object.getPrototypeOf(Uint8Array.prototype) as object,
]);

function isSlotBackedBuiltIn(instance: object): boolean {
  let proto: object | null = Object.getPrototypeOf(instance);
  while (proto) {
    if (SLOT_BACKED_PROTOTYPES.has(proto)) {
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/** Whether `fn` is engine/platform-provided rather than user code (`class Cache extends Map` is not). */
function isNativeFunction(fn: unknown): boolean {
  if (typeof fn !== "function") {
    return true;
  }
  try {
    return /\{\s*\[native code\]\s*\}$/.test(
      Function.prototype.toString.call(fn),
    );
  } catch {
    return true;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
const privateMemberCache = new WeakMap<Function, boolean>();

/**
 * Whether any class in the instance's prototype chain declares native private
 * members (`#field`, `#method()`). Detected from the class source, since
 * private members are only touchable from inside the lexical class body; a
 * `#` inside a string or comment can false-positive, which merely costs
 * nested self-call spans, so the cheap test is safe to lean on.
 */
function usesNativePrivateMembers(instance: object): boolean {
  let proto: object | null = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    const ctor = proto.constructor;
    if (typeof ctor === "function" && ctor !== Object) {
      let hasPrivate = privateMemberCache.get(ctor);
      if (hasPrivate === undefined) {
        hasPrivate = declaresPrivateMembers(ctor);
        privateMemberCache.set(ctor, hasPrivate);
      }
      if (hasPrivate) {
        return true;
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function declaresPrivateMembers(ctor: Function): boolean {
  try {
    // A private name's leading `#` is never preceded by an identifier
    // character; `obj.#x`, `#x in obj`, and declarations all match.
    return /(^|[^\w$])#[\w$]/.test(Function.prototype.toString.call(ctor));
  } catch {
    return false;
  }
}

function copyReflectMetadata(from: object, to: object): void {
  const getMetadataKeys = (
    Reflect as unknown as { getMetadataKeys?: (target: object) => unknown[] }
  ).getMetadataKeys;
  const getMetadata = (
    Reflect as unknown as {
      getMetadata?: (key: unknown, target: object) => unknown;
    }
  ).getMetadata;
  const defineMetadata = (
    Reflect as unknown as {
      defineMetadata?: (key: unknown, value: unknown, target: object) => void;
    }
  ).defineMetadata;
  if (!getMetadataKeys || !getMetadata || !defineMetadata) {
    return;
  }
  for (const key of getMetadataKeys(from)) {
    defineMetadata(key, getMetadata(key, from), to);
  }
}

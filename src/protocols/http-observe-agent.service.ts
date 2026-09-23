import {
  Inject,
  Injectable,
  Optional,
  RequestMethod,
  type OnModuleInit,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from "@opentelemetry/api";
import {
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
} from "@opentelemetry/semantic-conventions";
import type { ObserveOptions } from "../interfaces/observe-options.interface.js";
import { OBSERVE_OPTIONS } from "../observe.constants.js";
import {
  httpPathname,
  shouldIgnoreHttpRequest,
} from "../utils/default-http-ignore.js";

const OBSERVE_SPAN_KEY = "__observeSpan";

type HttpRequest = {
  url: string;
  method: string;
  headers?: Record<string, unknown>;
  [OBSERVE_SPAN_KEY]?: Span;
};

type HttpResponse = {
  statusCode: number;
  once?: (event: string, listener: () => void) => void;
};

function endSpanIfRecording(span: Span): void {
  if (span.isRecording()) {
    span.end();
  }
}

type NestHttpAdapterHooks = {
  setOnRequestHook?: (
    hook: (req: HttpRequest, res: unknown, done: () => void) => void,
  ) => void;
  setOnResponseHook?: (
    hook: (req: HttpRequest, res: HttpResponse) => void,
  ) => void;
  setOnRouteTriggered?: (
    hook: (requestMethod: RequestMethod, path: string) => void,
  ) => void;
};

@Injectable()
export class HttpObserveAgentService implements OnModuleInit {
  constructor(
    @Optional() private readonly httpAdapterHost?: HttpAdapterHost,
    @Optional()
    @Inject(OBSERVE_OPTIONS)
    private readonly options?: ObserveOptions,
  ) {
    this.registerHttpHooks();
  }

  onModuleInit(): void {
    this.httpAdapterHost?.init$?.subscribe(() => this.registerHttpHooks());
    this.httpAdapterHost?.listen$?.subscribe(() => this.registerHttpHooks());
  }

  registerHttpHooks(): void {
    const httpAdapter = this.httpAdapterHost?.httpAdapter as
      NestHttpAdapterHooks | undefined;
    if (!httpAdapter) {
      return;
    }

    httpAdapter.setOnRequestHook?.((req, res, done) => {
      this.onRequest(req, res, done);
    });
    httpAdapter.setOnResponseHook?.((req, res) => {
      this.onResponse(req, res);
    });
    httpAdapter.setOnRouteTriggered?.((requestMethod, route) => {
      const method = RequestMethod[requestMethod];
      const span = trace.getSpan(context.active());
      span?.updateName(`${method} ${route}`);
      span?.setAttribute(ATTR_HTTP_ROUTE, route);
    });
  }

  private onRequest(req: HttpRequest, res: unknown, done: () => void): void {
    const extracted = propagation.extract(context.active(), req.headers ?? {});

    if (shouldIgnoreHttpRequest(req, this.options?.http?.ignore)) {
      return done();
    }

    const pathname = httpPathname(req.url ?? "/");
    const span = trace
      .getTracer("@crudmates/observe")
      .startSpan(
        `${req.method} ${pathname}`,
        { kind: SpanKind.SERVER },
        extracted,
      );
    req[OBSERVE_SPAN_KEY] = span;
    const response = res as HttpResponse | undefined;
    response?.once?.("close", () => {
      endSpanIfRecording(span);
    });
    context.with(trace.setSpan(extracted, span), () => done());
  }

  private onResponse(req: HttpRequest, res: HttpResponse): void {
    const span = req[OBSERVE_SPAN_KEY];
    if (!span) {
      return;
    }
    span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, res.statusCode);
    if (res.statusCode >= 500) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    endSpanIfRecording(span);
  }
}

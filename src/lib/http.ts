import { DEFAULT_HTTP_TIMEOUT_MS } from "./constants";
import { CliError, EXIT_CODES } from "./errors";
import { compactObject } from "./util";

export interface RequestSpec {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
}

export interface HttpClientOptions {
  apiKey?: string;
  baseUrl: string;
  userAgent: string;
  fetchImpl?: typeof fetch;
}

export class ApiError extends CliError {
  status: number;
  responseBody?: unknown;

  constructor(message: string, status: number, responseBody?: unknown) {
    super(message, status === 404 ? EXIT_CODES.NOT_FOUND : EXIT_CODES.API, { details: responseBody });
    this.name = "ApiError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function buildUrl(baseUrl: string, request: RequestSpec): string {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}${request.path.startsWith("/") ? request.path : `/${request.path}`}`);

  for (const [key, value] of Object.entries(request.query || {})) {
    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        url.searchParams.append(key, String(entry));
      }
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

async function parseResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }

  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createHttpClient(options: HttpClientOptions) {
  const fetchImpl = options.fetchImpl || fetch;

  async function request<T = unknown>(spec: RequestSpec): Promise<ApiResponse<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), spec.timeoutMs || DEFAULT_HTTP_TIMEOUT_MS);
    const headers = compactObject({
      Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
      "User-Agent": options.userAgent,
      "X-API-KEY": options.apiKey,
      ...(spec.headers || {}),
    }) as Record<string, string>;

    let body: BodyInit | undefined;
    if (spec.body !== undefined) {
      if (spec.body instanceof FormData) {
        body = spec.body;
      } else {
        headers["Content-Type"] = headers["Content-Type"] || "application/json";
        body = headers["Content-Type"].includes("application/json") ? JSON.stringify(spec.body) : String(spec.body);
      }
    }

    try {
      const response = await fetchImpl(buildUrl(options.baseUrl, spec), {
        method: spec.method,
        headers,
        body,
        signal: controller.signal,
      });

      const payload = await parseResponse(response);

      if (!response.ok) {
        let message = `${spec.method.toUpperCase()} ${spec.path} failed with status ${response.status}.`;
        if (payload && typeof payload === "object" && "message" in (payload as Record<string, unknown>)) {
          message = String((payload as Record<string, unknown>).message);
        }
        throw new ApiError(message, response.status, payload);
      }

      return {
        status: response.status,
        headers: response.headers,
        data: payload as T,
      };
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new CliError(`Request to ${spec.path} timed out.`, EXIT_CODES.NETWORK);
      }

      if (error instanceof Error) {
        throw new CliError(error.message, EXIT_CODES.NETWORK);
      }

      throw new CliError("The request failed.", EXIT_CODES.NETWORK, { details: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function requestFirstAvailable<T = unknown>(specs: RequestSpec[]): Promise<ApiResponse<T>> {
    let lastError: unknown;

    for (const spec of specs) {
      try {
        return await request<T>(spec);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
          lastError = error;
          continue;
        }

        throw error;
      }
    }

    if (lastError instanceof ApiError) {
      throw lastError;
    }

    throw new CliError("No API endpoint handled the request.", EXIT_CODES.API);
  }

  return {
    request,
    requestFirstAvailable,
    get: <T = unknown>(path: string, query?: Record<string, unknown>) => request<T>({ method: "GET", path, query }),
    post: <T = unknown>(path: string, body?: unknown, query?: Record<string, unknown>) => request<T>({ method: "POST", path, body, query }),
    delete: <T = unknown>(path: string, body?: unknown, query?: Record<string, unknown>) => request<T>({ method: "DELETE", path, body, query }),
  };
}

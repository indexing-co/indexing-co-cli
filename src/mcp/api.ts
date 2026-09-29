import { API_KEY_GUIDANCE } from "../lib/auth";

export const MCP_API_KEY_GUIDANCE = `No API key configured. ${API_KEY_GUIDANCE} You can also set INDEXING_CO_API_KEY in the MCP server's environment.`;

export class ApiClient {
  constructor(
    private baseUrl: string,
    private apiKey: string | undefined,
    private userAgent: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async get(path: string, query?: Record<string, string>): Promise<unknown> {
    let url = `${this.baseUrl}${path}`;
    if (query) {
      url += `?${new URLSearchParams(query).toString()}`;
    }
    return this.handle(await this.fetchImpl(url, { headers: this.headers() }));
  }

  async post(path: string, body?: unknown): Promise<unknown> {
    return this.handle(
      await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  }

  async delete(path: string, body?: unknown): Promise<unknown> {
    return this.handle(
      await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "DELETE",
        headers: this.headers(),
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  }

  private headers(): Record<string, string> {
    if (!this.apiKey) {
      throw new Error(MCP_API_KEY_GUIDANCE);
    }
    return { "X-API-KEY": this.apiKey, "Content-Type": "application/json", "User-Agent": this.userAgent };
  }

  private async handle(res: Response): Promise<unknown> {
    if (!res.ok) {
      throw new Error(`API ${res.status}: ${await res.text()}`);
    }
    const contentType = res.headers.get("content-type") || "";
    return contentType.includes("application/json") ? res.json() : res.text();
  }
}

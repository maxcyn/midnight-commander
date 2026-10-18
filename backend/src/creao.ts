const API_BASE = () => (process.env.CREAO_API_BASE ?? "https://agent.creao.ai/api/v1").replace(/\/+$/, "");

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export interface CreaoRun {
  id: string;
  status: string;
  [key: string]: unknown;
}

function parseRun(value: unknown): CreaoRun {
  if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).id !== "string" ||
      typeof (value as Record<string, unknown>).status !== "string") {
    throw new Error("CREAO returned an invalid run response; expected string id and status fields");
  }
  return value as CreaoRun;
}

async function request(path: string, init: RequestInit) {
  const response = await fetch(`${API_BASE()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env("CREAO_API_KEY")}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`CREAO request ${path} returned ${response.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

// Start an investigation. The idempotency key makes retries return the same run
// instead of starting a second one.
export async function startRun(
  inputs: Record<string, unknown>,
  idempotencyKey: string,
): Promise<CreaoRun> {
  const publicUrl = env("PUBLIC_URL").replace(/\/+$/, "");
  const callback = new URL(`${publicUrl}/creao-callback`);
  callback.searchParams.set("token", env("WEBHOOK_SECRET"));
  const appId = env("CREAO_APP_ID");
  const result = await request("/runs", {
    method: "POST",
    body: JSON.stringify({ appId, inputs, webhookUrl: callback.toString(), idempotencyKey }),
  });
  return parseRun(result);
}

export async function getRun(id: string): Promise<CreaoRun> {
  const result = await request(`/runs/${encodeURIComponent(id)}`, { method: "GET" });
  return parseRun(result);
}

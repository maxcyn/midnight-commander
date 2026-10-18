const BASE = "https://agent.creao.ai";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export interface CreaoRun {
  id: string;
  status: string;
  [k: string]: unknown;
}

// Start an investigation. The idempotency key makes retries return the same run
// instead of starting a second one.
export async function startRun(
  inputs: Record<string, unknown>,
  idempotencyKey: string,
): Promise<CreaoRun> {
  const webhookUrl = `${env("PUBLIC_URL")}/creao-callback?token=${env("WEBHOOK_SECRET")}`;
  const res = await fetch(`${BASE}/api/v1/runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("CREAO_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ appId: env("CREAO_APP_ID"), inputs, webhookUrl, idempotencyKey }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`CREAO startRun ${res.status}: ${JSON.stringify(body)}`);
  return body as CreaoRun;
}

export async function getRun(id: string): Promise<CreaoRun> {
  const res = await fetch(`${BASE}/api/v1/runs/${id}`, {
    headers: { Authorization: `Bearer ${env("CREAO_API_KEY")}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`CREAO getRun ${res.status}: ${JSON.stringify(body)}`);
  return body as CreaoRun;
}

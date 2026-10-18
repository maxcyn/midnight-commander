import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface ManifestDependency {
  name: string;
  probe_path: string;
  normal_latency_ms?: number;
  timeout_ms?: number;
  degraded_latency_ms?: number;
  notes?: string;
}

export interface ManifestAction {
  action: string;
  addresses: string;
  parameters: Record<string, unknown>;
  endpoint: {
    method: "POST";
    path: string;
    body: Record<string, unknown>;
  };
  confirm_field: string;
  confirm_equals: unknown;
  tradeoff: string;
  retrospective: {
    summary: string;
    unresolved: string;
    followUp: string;
  };
}

export interface ServiceManifest {
  service: string;
  environment: string;
  description: string;
  request_path: string[];
  dependencies: ManifestDependency[];
  causes: string[];
  allowed_actions: ManifestAction[];
}

const defaultManifestPath = fileURLToPath(new URL("../service-manifest.json", import.meta.url));

export function loadManifest(customPath?: string): ServiceManifest {
  const path = customPath ?? process.env.SERVICE_MANIFEST_PATH ?? defaultManifestPath;
  const raw = JSON.parse(readFileSync(path, "utf8")) as ServiceManifest;
  if (!raw.service || !Array.isArray(raw.dependencies) || !Array.isArray(raw.allowed_actions) || !Array.isArray(raw.causes)) {
    throw new Error(`Invalid service manifest at ${path}`);
  }
  return raw;
}

export const manifest: ServiceManifest = loadManifest();

export const ALLOWED_ACTIONS_MAP: Record<string, ManifestAction> = Object.fromEntries(
  manifest.allowed_actions.map((a) => [a.action, a]),
);

export const DEPENDENCY_MAP: Record<string, ManifestDependency> = Object.fromEntries(
  manifest.dependencies.map((d) => [d.name, d]),
);

export type ToolPortalRouteId = 'resource-archiver' | 'sslscan' | 'runtime-hook';
export type ToolPortalPluginId = 'resource-archiver' | 'sslscan-auditor' | 'webcrypto-observer';
export type RuntimeHookAction = 'status' | 'analyze' | 'observe' | 'events' | 'mutation.set' | 'stop';
export const TOOL_PORTAL_REQUEST_PROOF_HEADER = 'x-mr-robot-tool-portal-request-proof';

export const TOOL_PORTAL_ROUTES: ReadonlyArray<{ routeId: ToolPortalRouteId; pluginId: ToolPortalPluginId; label: string }> = [
  { routeId: 'resource-archiver', pluginId: 'resource-archiver', label: 'Resource Archiver' },
  { routeId: 'sslscan', pluginId: 'sslscan-auditor', label: 'TLS Inspector' },
  { routeId: 'runtime-hook', pluginId: 'webcrypto-observer', label: 'Runtime Hook' },
];

export const TOOL_PORTAL_RPC = {
  status: 'toolPortal.status',
  configure: 'toolPortal.configure',
  disable: 'toolPortal.disable',
} as const;

export interface ToolPortalSession {
  authenticated: boolean;
  enabled: boolean;
  expiresAt?: number;
  hookMutationEnabled?: boolean;
}

export interface ToolPortalStatus {
  enabled: boolean;
  passwordConfigured: boolean;
  allowedDomains: string[];
  workspaceId?: string | null;
  workspaceName?: string;
  hookMutationEnabled: boolean;
}

export interface ToolPortalConfigureRequest {
  password?: string;
  allowedDomains: string[];
  workspaceId?: string | null;
  hookMutationEnabled: boolean;
}

export interface RuntimeHookCandidate {
  operation: string;
  api: string;
  line: number;
  column: number;
  confidence: 'high' | 'medium';
}

export interface RuntimeHookEvent {
  sequence: number;
  elapsedMs: number;
  operation: string;
  phase: 'encrypt-input' | 'decrypt-output';
  algorithm: string;
  byteLength: number;
  preview?: string;
  previewTruncated?: boolean;
  mutationApplied?: boolean;
}

export interface RuntimeHookSession {
  sessionId: string;
  running: boolean;
  targetUrl?: string;
  captureMode?: 'metadata-only' | 'plaintext';
  lastSequence?: number;
}

export function parseToolPortalPath(pathname: string): ToolPortalRouteId | null {
  const match = /^\/tools\/(resource-archiver|sslscan|runtime-hook)\/?$/.exec(pathname);
  return match?.[1] as ToolPortalRouteId | undefined ?? null;
}

export function portalPluginId(routeId: ToolPortalRouteId): ToolPortalPluginId {
  return TOOL_PORTAL_ROUTES.find((item) => item.routeId === routeId)!.pluginId;
}

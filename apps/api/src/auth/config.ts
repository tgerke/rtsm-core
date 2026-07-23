// Part 11-relevant knobs (P11-07, P11-08). Env-overridable so deployments can
// match their SOPs; defaults are deliberately conservative. Ported from
// lims-core with RTSM_ prefixes.
export interface AuthConfig {
  passwordMinLength: number;
  maxFailedLogins: number;
  lockoutMinutes: number;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  oidc: OidcConfig | null;
  /** When true, POST /auth/login is disabled — SSO is the only way in. */
  oidcOnly: boolean;
}

// Single identity provider per deployment (authorization-code flow with
// PKCE). Presence of RTSM_OIDC_ISSUER_URL enables SSO. Note: list-activation
// step-up is always the local password (P11-06), never an IdP round-trip, so
// OIDC-provisioned list managers need a local password set.
export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  providerLabel: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

function envBool(name: string): boolean {
  const raw = process.env[name];
  return raw === "1" || raw === "true";
}

function requireEnv(name: string): string {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required when RTSM_OIDC_ISSUER_URL is set`);
  return raw;
}

function loadOidcConfig(): OidcConfig | null {
  const issuerUrl = process.env.RTSM_OIDC_ISSUER_URL;
  if (!issuerUrl) return null;
  return {
    issuerUrl,
    clientId: requireEnv("RTSM_OIDC_CLIENT_ID"),
    clientSecret: requireEnv("RTSM_OIDC_CLIENT_SECRET"),
    redirectUri: requireEnv("RTSM_OIDC_REDIRECT_URI"),
    scopes: process.env.RTSM_OIDC_SCOPES ?? "openid profile email",
    providerLabel: process.env.RTSM_OIDC_PROVIDER_LABEL ?? "SSO",
  };
}

export function loadAuthConfig(): AuthConfig {
  const oidc = loadOidcConfig();
  const oidcOnly = envBool("RTSM_OIDC_ONLY");
  if (oidcOnly && !oidc) {
    throw new Error("RTSM_OIDC_ONLY requires RTSM_OIDC_ISSUER_URL to be configured");
  }
  return {
    passwordMinLength: envInt("RTSM_PASSWORD_MIN_LENGTH", 12),
    maxFailedLogins: envInt("RTSM_MAX_FAILED_LOGINS", 5),
    lockoutMinutes: envInt("RTSM_LOCKOUT_MINUTES", 15),
    sessionIdleMinutes: envInt("RTSM_SESSION_IDLE_MINUTES", 30),
    sessionAbsoluteHours: envInt("RTSM_SESSION_ABSOLUTE_HOURS", 8),
    oidc,
    oidcOnly,
  };
}

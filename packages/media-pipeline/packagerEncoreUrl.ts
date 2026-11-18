/**
 * Encore job URLs must be reachable from the encore-packager container.
 * Host supervisors often use http://127.0.0.1:8080 — rewrite those for Docker DNS.
 */

/** URL.hostname returns IPv6 literals in brackets (e.g. `[::1]`). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** True when hostname is only valid inside the supervisor/host process, not packager. */
export function isLoopbackEncoreUrl(urlString: string): boolean {
  try {
    const u = new URL(urlString);
    return LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const AGGREGATE_PATH_FRAGMENT = '/vmp/api/encoreJobAggregate/';

/**
 * Rewrite Encore job URL so encore-packager can GET it.
 *
 * Priority:
 * 1. PACKAGER_ENCORE_BASE_URL (explicit)
 * 2. Aggregate job docs live on the supervisor → PACKAGER_SUPERVISOR_BASE_URL
 * 3. If URL is loopback → http://encore-web:8080 (Compose service name)
 * 4. Otherwise leave unchanged (already docker-DNS or public)
 */
export function rewriteEncoreJobUrlForPackager(
  encoreJobUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = String(encoreJobUrl ?? '').trim();
  if (!raw) return raw;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }

  if (parsed.pathname.startsWith(AGGREGATE_PATH_FRAGMENT)) {
    const supervisorBase = trimTrailingSlash(
      env.PACKAGER_SUPERVISOR_BASE_URL || 'http://vmp-supervisor:8788',
    );
    let base: URL;
    try {
      base = new URL(supervisorBase.includes('://') ? supervisorBase : `http://${supervisorBase}`);
    } catch {
      throw new Error('Invalid PACKAGER_SUPERVISOR_BASE_URL');
    }
    parsed.protocol = base.protocol;
    // host setter keeps the old port when the value lacks one — assign both.
    parsed.hostname = base.hostname;
    parsed.port = base.port;
    return parsed.toString();
  }

  const explicit = (env.PACKAGER_ENCORE_BASE_URL || '').trim();
  if (explicit) {
    let base: URL;
    try {
      base = new URL(trimTrailingSlash(explicit.includes('://') ? explicit : `http://${explicit}`));
    } catch {
      throw new Error('Invalid PACKAGER_ENCORE_BASE_URL');
    }
    parsed.protocol = base.protocol;
    parsed.hostname = base.hostname;
    parsed.port = base.port;
    return parsed.toString();
  }

  if (isLoopbackEncoreUrl(raw)) {
    parsed.hostname = 'encore-web';
    parsed.port = parsed.port || '8080';
    if (parsed.protocol === 'https:') parsed.protocol = 'http:';
    return parsed.toString();
  }

  return raw;
}

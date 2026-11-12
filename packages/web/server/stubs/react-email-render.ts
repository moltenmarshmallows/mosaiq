/**
 * Stub for `@react-email/render`, aliased in `nuxt.config.ts` (`nitro.alias`).
 *
 * posthog-node >=5.64 dynamically imports it only when
 * `client.emails.send({ react })` runs — this app never uses `client.emails`
 * (PostHog transactional email also requires a secret API key we never
 * configure). Nitro's Cloudflare preset forbids unresolved externals, so the
 * optional import must resolve to something; this throws if it is ever called.
 */
const unavailable = (): never => {
  throw new Error(
    '@react-email/render is not bundled in this build — pass `html`/`text` to posthog emails.send() instead of `react`.',
  );
};

export const render = unavailable;
export const toPlainText = unavailable;
export default { render, toPlainText };

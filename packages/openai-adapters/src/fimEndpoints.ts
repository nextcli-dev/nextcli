/**
 * Fill-in-the-middle (FIM) is a property of the endpoint, not of the model
 * family. DeepSeek's `/beta/completions` and Mistral's `/v1/fim/completions`
 * exist only on the vendors' own hosts; a gateway (OneProvider, OpenRouter,
 * Portkey, ...) or a local bridge serving the same models has no FIM route
 * and answers 404. Autocomplete must fall back to chat there.
 */
const FIM_HOSTS: Record<string, readonly string[]> = {
  deepseek: ["api.deepseek.com"],
  mistral: ["api.mistral.ai", "codestral.mistral.ai"],
};

function hostOf(apiBase: string): string | undefined {
  try {
    return new URL(apiBase).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Whether `apiBase` is a host known to serve the provider's FIM endpoint.
 * An unset `apiBase` means the provider's own default host.
 */
export function supportsFimEndpoint(
  provider: string,
  apiBase: string | undefined,
): boolean {
  const hosts = FIM_HOSTS[provider];
  if (!hosts) {
    return false;
  }
  if (!apiBase) {
    return true;
  }
  const host = hostOf(apiBase);
  return host !== undefined && hosts.includes(host);
}

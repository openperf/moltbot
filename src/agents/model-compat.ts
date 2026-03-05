import type { Api, Model } from "@mariozechner/pi-ai";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

/**
 * Returns true only for endpoints that are confirmed to be native OpenAI
 * infrastructure and therefore accept the `developer` message role.
 * Azure OpenAI uses the Chat Completions API and does NOT accept `developer`.
 * All other openai-completions backends (proxies, Qwen, GLM, DeepSeek, etc.)
 * only support the standard `system` role.
 */
function isOpenAINativeEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.openai.com";
  } catch {
    return false;
  }
}

/**
 * Returns true for providers that do NOT require the automatic "-chat" suffix
 * appended by pi-ai's openai-completions adapter.
 *
 * Some providers like MiniMax use model IDs without the "-chat" suffix.
 * When pi-ai automatically appends "-chat" to model IDs, it breaks compatibility
 * with these providers.
 *
 * This function identifies providers that should have the automatic suffix
 * disabled via the `disableAutoModelIdSuffix` compatibility flag.
 */
function shouldDisableAutoModelIdSuffix(baseUrl: string): boolean {
  if (!baseUrl) {
    return false;
  }

  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    // MiniMax API does not use "-chat" suffix in model IDs
    if (host.includes("minimax")) {
      return true;
    }
    // Add other providers here as needed
    return false;
  } catch {
    return false;
  }
}

function isAnthropicMessagesModel(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

/**
 * pi-ai constructs the Anthropic API endpoint as `${baseUrl}/v1/messages`.
 * If a user configures `baseUrl` with a trailing `/v1` (e.g. the previously
 * recommended format "https://api.anthropic.com/v1"), the resulting URL
 * becomes "…/v1/v1/messages" which the Anthropic API rejects with a 404.
 *
 * Strip a single trailing `/v1` (with optional trailing slash) from the
 * baseUrl for anthropic-messages models so users with either format work.
 */
function normalizeAnthropicBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}
export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  const baseUrl = model.baseUrl ?? "";

  // Normalise anthropic-messages baseUrl: strip trailing /v1 that users may
  // have included in their config. pi-ai appends /v1/messages itself.
  if (isAnthropicMessagesModel(model) && baseUrl) {
    const normalised = normalizeAnthropicBaseUrl(baseUrl);
    if (normalised !== baseUrl) {
      return { ...model, baseUrl: normalised } as Model<"anthropic-messages">;
    }
  }

  if (!isOpenAiCompletionsModel(model)) {
    return model;
  }

  const compat = model.compat ?? undefined;

  // Disable automatic model ID suffix for providers that don't use it.
  // For example, MiniMax uses model IDs like "abab6.5" without the "-chat" suffix.
  // If we let pi-ai automatically append "-chat", it becomes "abab6.5-chat" which
  // the MiniMax API rejects as an unknown model.
  // This check runs before supportsDeveloperRole handling to ensure it applies
  // even for models that already have supportsDeveloperRole: false configured.
  if (shouldDisableAutoModelIdSuffix(baseUrl)) {
    const newCompat = {
      ...compat,
      supportsDeveloperRole: false,
      disableAutoModelIdSuffix: true,
    };
    return {
      ...model,
      compat: newCompat,
    } as typeof model;
  }

  // The `developer` message role is an OpenAI-native convention. All other
  // openai-completions backends (proxies, Qwen, GLM, DeepSeek, Kimi, etc.)
  // only recognise `system`. Force supportsDeveloperRole=false for any model
  // whose baseUrl is not a known native OpenAI endpoint, unless the caller
  // has already pinned the value explicitly.
  if (compat?.supportsDeveloperRole === false) {
    return model;
  }

  // When baseUrl is empty the pi-ai library defaults to api.openai.com, so
  // leave compat unchanged and let the existing default behaviour apply.
  // Note: an explicit supportsDeveloperRole: true is intentionally overridden
  // here for non-native endpoints — those backends would return a 400 if we
  // sent `developer`, so safety takes precedence over the caller's hint.
  const needsForce = baseUrl ? !isOpenAINativeEndpoint(baseUrl) : false;
  if (!needsForce) {
    return model;
  }

  // Return a new object — do not mutate the caller's model reference.
  return {
    ...model,
    compat: compat ? { ...compat, supportsDeveloperRole: false } : { supportsDeveloperRole: false },
  } as typeof model;
}

interface ProviderIdentityDescriptor {
  iconPath?: string;
  initials: string;
  label: string;
}

const OFFICIAL_ICON_PATHS: Readonly<Record<string, string>> = Object.freeze({
  anthropic: "./icons/providers/anthropic.svg",
  deepseek: "./icons/providers/deepseek.svg",
  google: "./icons/providers/google.svg",
  openai: "./icons/providers/openai.svg",
  openrouter: "./icons/providers/openrouter.svg",
});

function deriveProviderId(name: string, existingIds: Iterable<string>): string {
  const baseId = name
    .trim()
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.join("-") || "custom-provider";
  const existing = new Set(existingIds);

  if (!existing.has(baseId)) return baseId;

  let suffix = 2;
  while (existing.has(`${baseId}-${suffix}`)) suffix += 1;
  return `${baseId}-${suffix}`;
}

function deriveOpenAiDiscoveryPath(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;

    const basePath = parsed.pathname.replace(/\/+$/, "");
    return `${basePath}/models`;
  } catch {
    return null;
  }
}

function providerHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

function providerInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return words.slice(0, 2).map((word) => Array.from(word)[0] || "").join("").toUpperCase();
  }
  return Array.from(words[0] || "").slice(0, 2).join("").toUpperCase();
}

function identity(providerId: string, name: string, isCustom: boolean): ProviderIdentityDescriptor {
  const iconPath = isCustom ? undefined : OFFICIAL_ICON_PATHS[providerId.toLowerCase()];
  return {
    ...(iconPath ? { iconPath } : {}),
    initials: providerInitials(name),
    label: name,
  };
}

export const ProviderSettingsUtils = Object.freeze({
  deriveProviderId,
  deriveOpenAiDiscoveryPath,
  providerHost,
  identity,
});

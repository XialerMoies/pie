import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { withFileLock, type FileLockOptions } from "../data/file-lock.js";
import {
  assertSafeHeaderName,
  validateCustomProviderDefinition,
  validateCustomProviderSnapshot,
  type CredentialRef,
  type CustomProviderDefinition,
  type CustomProviderSnapshot,
  type RedactedCustomProviderSnapshot,
  type ResolvedProviderSecrets,
} from "./contracts.js";

interface SecretDocument {
  schemaVersion: 1;
  values: Record<CredentialRef, string>;
}

export interface SecretPatch {
  apiKey?: string | null;
  headers: Array<{ name: string; value?: string; remove?: boolean }>;
}

export type StoredProviderMutation = Omit<CustomProviderDefinition, "apiKeyRef" | "headers"> & {
  headers: string[];
};

export interface CustomProviderCommit {
  expectedRevision: number;
  provider?: StoredProviderMutation;
  removeProviderId?: string;
  secretPatch: SecretPatch;
}

export type CustomProviderAtomicWrite = (filePath: string, contents: string) => Promise<void>;

export interface CustomProviderStoreOptions {
  configFile: string;
  secretsFile: string;
  atomicWrite?: CustomProviderAtomicWrite;
  lock?: FileLockOptions;
}

export class CustomProviderRevisionConflict extends Error {
  constructor(
    public readonly expectedRevision: number,
    public readonly currentRevision: number,
  ) {
    super(`Custom provider revision conflict: expected ${expectedRevision}, current ${currentRevision}`);
    this.name = "CustomProviderRevisionConflict";
  }
}

const EMPTY_SNAPSHOT = (): CustomProviderSnapshot => ({ schemaVersion: 1, revision: 0, providers: [] });
const EMPTY_SECRETS = (): SecretDocument => ({ schemaVersion: 1, values: {} });
const CREDENTIAL_REF_PATTERN = /^credential:[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new Error(`${path}: contains an unknown field`);
}

function validateSecretDocument(value: unknown): SecretDocument {
  if (!isPlainObject(value)) throw new Error("secrets: must be a plain object");
  rejectUnknownFields(value, ["schemaVersion", "values"], "secrets");
  if (value.schemaVersion !== 1) throw new Error("secrets.schemaVersion: must equal 1");
  if (!isPlainObject(value.values)) throw new Error("secrets.values: must be a plain object");
  for (const [reference, secret] of Object.entries(value.values)) {
    if (!CREDENTIAL_REF_PATTERN.test(reference)) {
      throw new Error("secrets.values: contains an invalid credential reference");
    }
    if (typeof secret !== "string") throw new Error("secrets.values: credential values must be strings");
  }
  return value as unknown as SecretDocument;
}

async function readJsonOrDefault<T>(filePath: string, fallback: () => T, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error: any) {
    if (error?.code === "ENOENT") return fallback();
    if (error instanceof SyntaxError) throw new Error(`${label}: invalid JSON`);
    throw error;
  }
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function defaultAtomicWrite(filePath: string, contents: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function referencedCredentials(snapshot: CustomProviderSnapshot): Set<CredentialRef> {
  const references = new Set<CredentialRef>();
  for (const provider of snapshot.providers) {
    if (provider.apiKeyRef !== undefined) references.add(provider.apiKeyRef);
    for (const header of provider.headers) references.add(header.credentialRef);
  }
  return references;
}

function requireReferencedSecrets(snapshot: CustomProviderSnapshot, secrets: SecretDocument): void {
  for (const reference of referencedCredentials(snapshot)) {
    if (!Object.prototype.hasOwnProperty.call(secrets.values, reference)) {
      throw new Error("Missing secret for a configured custom provider credential");
    }
  }
}

function cloneSnapshot(snapshot: CustomProviderSnapshot): CustomProviderSnapshot {
  return structuredClone(snapshot);
}

function credentialRef(): CredentialRef {
  return `credential:${randomUUID()}`;
}

function validateSecretPatch(patch: SecretPatch): Map<string, SecretPatch["headers"][number]> {
  if (!isPlainObject(patch)) throw new Error("secretPatch: must be a plain object");
  rejectUnknownFields(patch, ["apiKey", "headers"], "secretPatch");
  if (patch.apiKey !== undefined && patch.apiKey !== null && typeof patch.apiKey !== "string") {
    throw new Error("secretPatch.apiKey: must be a string, null, or undefined");
  }
  if (typeof patch.apiKey === "string" && patch.apiKey.trim().length === 0) {
    throw new Error("secretPatch.apiKey: must be a non-empty string");
  }
  if (!Array.isArray(patch.headers)) throw new Error("secretPatch.headers: must be an array");

  const entries = new Map<string, SecretPatch["headers"][number]>();
  for (let index = 0; index < patch.headers.length; index += 1) {
    const entry = patch.headers[index];
    const path = `secretPatch.headers[${index}]`;
    if (!isPlainObject(entry)) throw new Error(`${path}: must be a plain object`);
    rejectUnknownFields(entry, ["name", "value", "remove"], path);
    assertSafeHeaderName(entry.name, `${path}.name`);
    if (entry.value !== undefined && typeof entry.value !== "string") {
      throw new Error(`${path}.value: must be a string or undefined`);
    }
    if (entry.remove !== undefined && typeof entry.remove !== "boolean") {
      throw new Error(`${path}.remove: must be a boolean or undefined`);
    }
    if (entry.remove === true && entry.value !== undefined) {
      throw new Error(`${path}: cannot set value and remove together`);
    }
    const normalized = entry.name.toLowerCase();
    if (entries.has(normalized)) throw new Error(`${path}.name: duplicate header name: ${entry.name}`);
    entries.set(normalized, entry);
  }
  return entries;
}

function validateMutationHeaders(
  headers: StoredProviderMutation["headers"],
): Map<string, string> {
  if (!Array.isArray(headers)) throw new Error("provider.headers: must be an array");
  const entries = new Map<string, string>();
  for (let index = 0; index < headers.length; index += 1) {
    const headerName = headers[index];
    const path = `provider.headers[${index}]`;
    assertSafeHeaderName(headerName, path);
    const normalized = headerName.toLowerCase();
    if (entries.has(normalized)) throw new Error(`${path}: duplicate header name: ${headerName}`);
    entries.set(normalized, headerName);
  }
  return entries;
}

function validateProviderMutation(value: unknown): asserts value is StoredProviderMutation {
  if (!isPlainObject(value)) throw new Error("provider: must be a plain object");
  rejectUnknownFields(value, [
    "id", "name", "protocol", "baseUrl", "authMode", "headers", "modelDiscovery", "models",
  ], "provider");
  validateMutationHeaders(value.headers as StoredProviderMutation["headers"]);
}

interface StoreState {
  snapshot: CustomProviderSnapshot;
  secrets: SecretDocument;
}

export class CustomProviderStore {
  private readonly configFile: string;
  private readonly secretsFile: string;
  private readonly atomicWrite: CustomProviderAtomicWrite;
  private readonly lock?: FileLockOptions;

  constructor(options: CustomProviderStoreOptions) {
    this.configFile = options.configFile;
    this.secretsFile = options.secretsFile;
    this.atomicWrite = options.atomicWrite ?? defaultAtomicWrite;
    this.lock = options.lock;
  }

  private withLock<T>(callback: () => T | Promise<T>): Promise<T> {
    return withFileLock(`${this.configFile}.lock`, this.lock, callback);
  }

  private async readSnapshotUnlocked(): Promise<CustomProviderSnapshot> {
    return validateCustomProviderSnapshot(
      await readJsonOrDefault(this.configFile, EMPTY_SNAPSHOT, "custom provider configuration"),
    );
  }

  private async readSecretsUnlocked(): Promise<SecretDocument> {
    return validateSecretDocument(
      await readJsonOrDefault(this.secretsFile, EMPTY_SECRETS, "custom provider secrets"),
    );
  }

  private async readStateUnlocked(): Promise<StoreState> {
    const [snapshot, secrets] = await Promise.all([
      this.readSnapshotUnlocked(),
      this.readSecretsUnlocked(),
    ]);
    requireReferencedSecrets(snapshot, secrets);
    return { snapshot, secrets };
  }

  async readSnapshot(): Promise<CustomProviderSnapshot> {
    return this.withLock(async () => cloneSnapshot((await this.readStateUnlocked()).snapshot));
  }

  async readRedacted(): Promise<RedactedCustomProviderSnapshot> {
    return this.withLock(async () => {
      const { snapshot } = await this.readStateUnlocked();
      return {
        schemaVersion: 1,
        revision: snapshot.revision,
        providers: snapshot.providers.map(({ apiKeyRef, headers, ...provider }) => ({
          ...structuredClone(provider),
          apiKeyConfigured: apiKeyRef !== undefined,
          headers: headers.map((header) => ({ name: header.name, configured: true })),
        })),
      };
    });
  }

  async revealApiKey(providerId: string): Promise<string | undefined> {
    return this.withLock(async () => {
      const { snapshot, secrets } = await this.readStateUnlocked();
      const provider = snapshot.providers.find((candidate) => candidate.id === providerId);
      if (provider?.apiKeyRef === undefined) return undefined;
      return secrets.values[provider.apiKeyRef];
    });
  }

  async resolveSecrets(providerDefinition: CustomProviderDefinition): Promise<ResolvedProviderSecrets> {
    return this.withLock(async () => {
      const input = validateCustomProviderDefinition(providerDefinition);
      const { snapshot, secrets } = await this.readStateUnlocked();
      const provider = snapshot.providers.find((candidate) => candidate.id === input.id);
      if (provider === undefined || !isDeepStrictEqual(input, provider)) {
        throw new Error(`Provider definition is stale or does not match stored provider: ${input.id}`);
      }

      const resolved: ResolvedProviderSecrets = {
        headers: Object.create(null) as Record<string, string>,
      };
      if (provider.apiKeyRef !== undefined) {
        resolved.apiKey = secrets.values[provider.apiKeyRef];
      }
      for (const header of provider.headers) {
        resolved.headers[header.name] = secrets.values[header.credentialRef];
      }
      return resolved;
    });
  }

  private async cleanOrphans(snapshot: CustomProviderSnapshot, secrets: SecretDocument): Promise<void> {
    const references = referencedCredentials(snapshot);
    const values = Object.fromEntries(
      Object.entries(secrets.values).filter(([reference]) => references.has(reference as CredentialRef)),
    ) as Record<CredentialRef, string>;
    if (Object.keys(values).length === Object.keys(secrets.values).length) return;
    try {
      await this.atomicWrite(this.secretsFile, serialize({ schemaVersion: 1, values } satisfies SecretDocument));
    } catch {
      // Configuration is already committed. Orphan cleanup is deliberately best-effort.
    }
  }

  private async writeCommitPoint(
    current: CustomProviderSnapshot,
    committed: CustomProviderSnapshot,
    originalSecrets: SecretDocument,
    committedSecrets: SecretDocument,
    secretsPrewritten: boolean,
  ): Promise<CustomProviderSnapshot> {
    try {
      await this.atomicWrite(this.configFile, serialize(committed));
    } catch (configError) {
      let persisted: CustomProviderSnapshot;
      try {
        persisted = await this.readSnapshotUnlocked();
      } catch {
        throw configError;
      }
      if (isDeepStrictEqual(persisted, committed)) {
        await this.cleanOrphans(committed, committedSecrets);
        return cloneSnapshot(committed);
      }
      if (secretsPrewritten && isDeepStrictEqual(persisted, current)) {
        try {
          await this.atomicWrite(this.secretsFile, serialize(originalSecrets));
        } catch {
          // Keep the original config error; merged values are harmless orphans.
        }
      }
      throw configError;
    }
    await this.cleanOrphans(committed, committedSecrets);
    return cloneSnapshot(committed);
  }

  async commit(mutation: CustomProviderCommit): Promise<CustomProviderSnapshot> {
    return this.withLock(async () => {
      const { snapshot: current, secrets } = await this.readStateUnlocked();
      if (!Number.isSafeInteger(mutation.expectedRevision) || mutation.expectedRevision < 0) {
        throw new Error("expectedRevision: must be a non-negative safe integer");
      }
      if (mutation.expectedRevision !== current.revision) {
        throw new CustomProviderRevisionConflict(mutation.expectedRevision, current.revision);
      }
      if (current.revision >= Number.MAX_SAFE_INTEGER) {
        throw new Error("revision cannot increment beyond the maximum safe integer");
      }
      if ((mutation.provider === undefined) === (mutation.removeProviderId === undefined)) {
        throw new Error("commit must contain exactly one provider or removeProviderId");
      }
      const patchEntries = validateSecretPatch(mutation.secretPatch);

      if (mutation.removeProviderId !== undefined) {
        if (typeof mutation.removeProviderId !== "string" || mutation.removeProviderId.length === 0) {
          throw new Error("removeProviderId: must be a non-empty string");
        }
        if (mutation.secretPatch.apiKey !== undefined || patchEntries.size > 0) {
          throw new Error("secretPatch: deletion cannot change secrets");
        }
        const providers = current.providers.filter((provider) => provider.id !== mutation.removeProviderId);
        if (providers.length === current.providers.length) {
          throw new Error(`Unknown custom provider: ${mutation.removeProviderId}`);
        }
        const committed = validateCustomProviderSnapshot({
          schemaVersion: 1,
          revision: current.revision + 1,
          providers,
        });
        return this.writeCommitPoint(current, committed, secrets, secrets, false);
      }

      const providerMutation = mutation.provider!;
      validateProviderMutation(providerMutation);
      const mutationHeaders = validateMutationHeaders(providerMutation.headers);
      const existingIndex = current.providers.findIndex((provider) => provider.id === providerMutation.id);
      const existing = existingIndex >= 0 ? current.providers[existingIndex] : undefined;
      const existingHeaders = new Map(
        (existing?.headers ?? []).map((header) => [header.name.toLowerCase(), header]),
      );
      const mergedSecrets: SecretDocument = {
        schemaVersion: 1,
        values: { ...secrets.values },
      };
      let wroteNewSecret = false;

      let apiKeyRef: CredentialRef | undefined;
      if (providerMutation.authMode === "apiKey") {
        if (typeof mutation.secretPatch.apiKey === "string") {
          apiKeyRef = credentialRef();
          mergedSecrets.values[apiKeyRef] = mutation.secretPatch.apiKey;
          wroteNewSecret = true;
        } else if (mutation.secretPatch.apiKey === null) {
          apiKeyRef = undefined;
        } else {
          const candidate = existing?.apiKeyRef;
          if (candidate !== undefined && Object.prototype.hasOwnProperty.call(mergedSecrets.values, candidate)) {
            apiKeyRef = candidate;
          }
        }
      } else if (mutation.secretPatch.apiKey !== undefined && mutation.secretPatch.apiKey !== null) {
        throw new Error("secretPatch.apiKey: authMode none cannot store an API key");
      }

      const headers: CustomProviderDefinition["headers"] = [];
      for (const [normalizedName, headerName] of mutationHeaders) {
        const patch = patchEntries.get(normalizedName);
        if (patch?.remove === true) continue;
        let reference: CredentialRef | undefined;
        if (patch?.value !== undefined) {
          reference = credentialRef();
          mergedSecrets.values[reference] = patch.value;
          wroteNewSecret = true;
        } else {
          const candidate = existingHeaders.get(normalizedName)?.credentialRef;
          if (candidate !== undefined && Object.prototype.hasOwnProperty.call(mergedSecrets.values, candidate)) {
            reference = candidate;
          }
        }
        if (reference === undefined) throw new Error(`Missing secret for provider header: ${headerName}`);
        headers.push({ name: headerName, credentialRef: reference });
      }
      for (const [normalizedName, patch] of patchEntries) {
        if (patch.remove !== true && !mutationHeaders.has(normalizedName)) {
          throw new Error(`secretPatch header is not present in provider: ${patch.name}`);
        }
      }

      const candidate = {
        ...providerMutation,
        ...(apiKeyRef === undefined ? {} : { apiKeyRef }),
        headers,
      } as Record<string, unknown>;
      if (apiKeyRef === undefined) delete candidate.apiKeyRef;
      const provider = validateCustomProviderDefinition(candidate);
      const providers = current.providers.slice();
      if (existingIndex >= 0) providers[existingIndex] = provider;
      else providers.push(provider);
      const committed = validateCustomProviderSnapshot({
        schemaVersion: 1,
        revision: current.revision + 1,
        providers,
      });
      requireReferencedSecrets(committed, mergedSecrets);

      if (wroteNewSecret) await this.atomicWrite(this.secretsFile, serialize(mergedSecrets));
      return this.writeCommitPoint(current, committed, secrets, mergedSecrets, wroteNewSecret);
    });
  }
}

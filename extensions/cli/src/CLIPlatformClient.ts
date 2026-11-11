import { DefaultApiInterface } from "@continuedev/sdk/dist/api";
import {
  FQSN,
  PlatformClient,
  SecretResult,
  SecretType,
} from "@nextcli/config-yaml";

export class CLIPlatformClient implements PlatformClient {
  constructor(
    private orgScopeId: string | null,
    private readonly apiClient: DefaultApiInterface,
  ) {}

  // ~/.continue/.env and a trusted folder's .continue/.env and .env are
  // already in process.env: the preAction hook loaded them (src/projectEnv.ts),
  // without the variables no file may set. No .env file is read here.
  private findSecretInProcessEnv(fqsn: FQSN): SecretResult | undefined {
    const secretValue = process.env[fqsn.secretName];
    if (secretValue) {
      return {
        found: true,
        fqsn,
        value: secretValue,
        secretLocation: {
          secretName: fqsn.secretName,
          secretType: SecretType.LocalEnv,
        },
      };
    }
    return undefined;
  }

  async resolveFQSNs(fqsns: FQSN[]): Promise<(SecretResult | undefined)[]> {
    if (fqsns.length === 0) {
      return [];
    }

    const results: (SecretResult | undefined)[] = new Array(fqsns.length).fill(
      undefined,
    );

    // First, check the environment for secrets (highest priority for CLI)
    // This allows users to override any secret with a local environment variable
    for (let i = 0; i < fqsns.length; i++) {
      const secretFromEnv = this.findSecretInProcessEnv(fqsns[i]);
      if (secretFromEnv?.found) {
        results[i] = secretFromEnv;
      }
    }

    // For secrets not found locally, try to resolve through the API
    const unresolvedIndices = results
      .map((r, i) => (r === undefined ? i : -1))
      .filter((i) => i !== -1);

    if (unresolvedIndices.length > 0) {
      try {
        const unresolvedFqsns = unresolvedIndices.map((i) => fqsns[i]);
        const apiResults: any = await this.apiClient.syncSecrets({
          syncSecretsRequest: {
            fqsns: unresolvedFqsns,
            orgScopeId: this.orgScopeId,
          },
        });

        // Merge API results - keep all found results (with or without value)
        for (let j = 0; j < apiResults.length; j++) {
          if (apiResults[j]?.found) {
            results[unresolvedIndices[j]] = apiResults[j];
          }
        }
      } catch (error) {
        console.warn(
          `Error resolving FQSNs through API: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return results;
  }
}

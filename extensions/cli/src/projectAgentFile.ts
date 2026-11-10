import * as fs from "fs";
import * as path from "path";

import { PROJECT_AGENT_FILE_NAMES } from "@nextcli/config-yaml";

/**
 * Finds the project agent file in `dir`: the first of AGENTS.md, AGENT.md,
 * CLAUDE.md and CODEX.md that exists. Decided by existence only, so the system
 * message and `/init` agree on the file.
 */
export function findProjectAgentFile(dir: string): string | undefined {
  for (const fileName of PROJECT_AGENT_FILE_NAMES) {
    const filePath = path.join(dir, fileName);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }
  return undefined;
}

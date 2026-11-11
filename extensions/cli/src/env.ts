import * as os from "os";
import * as path from "path";

// .env files are loaded by the bootstrap (src/bootstrap.ts), before this
// module is imported, and only from a trusted folder

export const env = {
  // Empty unless opted in. NextCLI does not call api.nextcli.dev.
  apiBase: process.env.NEXTCLI_API_BASE ?? "",
  continueHome:
    process.env.CONTINUE_GLOBAL_DIR || path.join(os.homedir(), ".continue"),
};

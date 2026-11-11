import * as os from "os";
import * as path from "path";

// .env files load in the preAction hook (src/projectEnv.ts). A project's
// .continue/.env and .env load only in a trusted folder; ~/.continue/.env
// loads in every folder. Neither may set the variables read here.

export const env = {
  // Empty unless opted in. NextCLI does not call api.nextcli.dev.
  apiBase: process.env.NEXTCLI_API_BASE ?? "",
  continueHome:
    process.env.CONTINUE_GLOBAL_DIR || path.join(os.homedir(), ".continue"),
};

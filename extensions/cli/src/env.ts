import * as os from "os";
import * as path from "path";

import dotenv from "dotenv";

dotenv.config();

export const env = {
  // Empty unless opted in. NextCLI does not call api.nextcli.dev.
  apiBase: process.env.NEXTCLI_API_BASE ?? "",
  continueHome:
    process.env.CONTINUE_GLOBAL_DIR || path.join(os.homedir(), ".continue"),
};

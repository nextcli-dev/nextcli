import { zodToJsonSchema } from "zod-to-json-schema";
import { configYamlSchema } from "../schemas/index.js";

// The editor's config.yaml schema is generated from the zod schema. Fields
// the CLI reads must be in it, or the editor marks valid configs invalid.
describe("generated JSON schema", () => {
  it("includes reasoningEffort in defaultCompletionOptions", () => {
    const schema = JSON.stringify(
      zodToJsonSchema(configYamlSchema, {
        $refStrategy: "none",
        name: "ConfigYaml",
      }),
    );
    expect(schema).toContain('"reasoningEffort"');
  });
});

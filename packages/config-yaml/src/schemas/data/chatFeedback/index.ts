import { z } from "zod";
import { baseDevDataAllSchema } from "../base.js";

export const chatFeedbackEventAllSchema = baseDevDataAllSchema.extend({
  modelProvider: z.string(),
  modelName: z.string(),
  modelTitle: z.string(),
  completionOptions: z.object({}),
  // Sessions don't keep prompts, so feedback on a stored message has none
  prompt: z.string().optional(),
  completion: z.string(),
  feedback: z.boolean().optional(),
  sessionId: z.string().uuid(),
});

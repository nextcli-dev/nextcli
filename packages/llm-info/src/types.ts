export type UseCase = "chat" | "autocomplete" | "rerank" | "embed";

export type ParameterType = "string" | "number" | "boolean";

export interface Parameter {
  key: string;
  required: boolean;
  valueType: ParameterType;
  displayName?: string;
  description?: string;
  defaultValue?: any;
}

export enum ChatTemplate {
  None = "none",
  // TODO
}

export interface LlmInfo {
  model: string;
  // providers: string[]; // TODO: uncomment and deal with the consequences
  displayName?: string;
  description?: string;
  contextLength?: number;
  maxCompletionTokens?: number;
  regex?: RegExp;
  chatTemplate?: ChatTemplate;

  /** If not set, assumes "text" only */
  mediaTypes?: MediaType[];
  recommendedFor?: UseCase[];

  /** Any additional parameters required to configure the model */
  extraParameters?: Parameter[];

  /**
   * Set when the vendor has announced the model's shutdown. The entry stays so
   * existing configs keep working, but presets and defaults must not use it.
   */
  deprecation?: LlmDeprecation;
}

export interface LlmDeprecation {
  /**
   * The vendor's shutdown date as YYYY-MM-DD, or "unscheduled" when the model
   * is deprecated without a date (e.g. a legacy alias)
   */
  shutdownDate: string;
  /** The model id the vendor recommends moving to */
  replacement?: string;
}

/**
 * True when the model has a shutdown date that is on or before `today`.
 * Models without a deprecation, or with an unscheduled one, are not retired.
 */
export function isRetired(
  info: Pick<LlmInfo, "deprecation"> | undefined,
  today: Date = new Date(),
): boolean {
  const date = info?.deprecation?.shutdownDate;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return false;
  }
  return new Date(`${date}T00:00:00Z`).getTime() <= today.getTime();
}

export type LlmInfoWithProvider = LlmInfo & {
  provider: string;
};

export enum MediaType {
  Text = "text",
  Image = "image",
  Audio = "audio",
  Video = "video",
}

export const AllMediaTypes = [
  MediaType.Text,
  MediaType.Image,
  MediaType.Audio,
  MediaType.Video,
];

export interface ApiProviderInfo {
  displayName: string;
  supportsStreaming: boolean;
  handlesTemplating: boolean;
}

export type ModelProviderCapability =
  | "stream"
  | "fim"
  | "image"
  | "template_chat"
  | "tools";

export interface ModelProvider {
  id: string;
  displayName: string;
  // capabilities: ModelProviderCapability[]; // TODO: uncomment and deal with the consequences
  models: Omit<LlmInfo, "provider">[];

  /** Any additional parameters required to configure the model
   *
   * (other than apiKey, apiBase, which are assumed always. And of course model and provider always required)
   */
  extraParameters?: Parameter[];
}

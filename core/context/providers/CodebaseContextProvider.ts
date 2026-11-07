import { BaseContextProvider } from "../";
import {
  ContextItem,
  ContextProviderDescription,
  ContextProviderExtras,
} from "../../";
import { retrieveContextItems } from "../retrieval/retrieval";

class CodebaseContextProvider extends BaseContextProvider {
  static description: ContextProviderDescription = {
    title: "codebase",
    displayTitle: "Codebase",
    description: "Automatically find relevant files",
    type: "normal",
    renderInlineAs: "",
    dependsOnIndexing: ["fullTextSearch", "chunk"],
  };

  async getContextItems(
    query: string,
    extras: ContextProviderExtras,
  ): Promise<ContextItem[]> {
    return retrieveContextItems(extras, this.options, undefined);
  }
  async load(): Promise<void> {}
}

export default CodebaseContextProvider;

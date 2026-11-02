import type { ModelConfig } from "@nextcli/config-yaml";
import { Text } from "ink";
import React, { useState } from "react";

import { services } from "../services/index.js";
import {
  effectiveEffort,
  effortLabel,
  formatContextLength,
  getContextOptions,
  getModelControlsFor,
  getModelSettings,
  updateModelSettings,
} from "../util/modelSettings.js";
import { DEFAULT_CONTEXT_LENGTH } from "../util/tokenizer.js";

import { ModelSelector } from "./ModelSelector.js";
import { Selector, SelectorOption } from "./Selector.js";

interface ModelOption extends SelectorOption {
  index: number;
  provider: string;
}

interface ModelMenuProps {
  onSelectModel: (model: ModelOption) => void;
  onCancel: () => void;
}

type MenuView = "main" | "models" | "effort" | "context";

interface MenuRow extends SelectorOption {
  value: string;
  opensSubmenu: boolean;
}

function currentModel(): ModelConfig | null {
  return services.model.getState()?.model ?? null;
}

function buildRows(model: ModelConfig | null): MenuRow[] {
  const rows: MenuRow[] = [
    {
      id: "model",
      name: "Model",
      value: model ? model.name || model.model : "None",
      opensSubmenu: true,
    },
  ];
  if (!model) {
    return rows;
  }
  const controls = getModelControlsFor(model);
  const settings = getModelSettings(model);
  if (controls.efforts.length > 0) {
    rows.push({
      id: "effort",
      name: "Effort",
      value: effortLabel(effectiveEffort(model)),
      opensSubmenu: true,
    });
  }
  if (controls.canShowThinking) {
    // Claude 4.6 to 4.8 only think once an effort is set
    const needsEffort = controls.thinkingNeedsEffort && !effectiveEffort(model);
    rows.push({
      id: needsEffort ? "thinking-needs-effort" : "thinking",
      name: "Show thinking",
      value: needsEffort
        ? "Needs effort"
        : settings.showThinking === false
          ? "Off"
          : "On",
      opensSubmenu: false,
    });
  }
  if (controls.fast) {
    rows.push({
      id: "fast",
      name: "Fast",
      value: settings.fast ? "On" : "Off",
      opensSubmenu: false,
    });
  }
  const contextOptions = getContextOptions(model, DEFAULT_CONTEXT_LENGTH);
  if (contextOptions.length > 1) {
    const configured =
      model.defaultCompletionOptions?.contextLength ?? DEFAULT_CONTEXT_LENGTH;
    rows.push({
      id: "context",
      name: "Context",
      value: formatContextLength(settings.contextLength ?? configured),
      opensSubmenu: true,
    });
  }
  return rows;
}

/**
 * The model menu (experimental): the current model plus its settings
 * (effort, readable thinking, fast mode, context window), like the model
 * picker in Cursor. Rows a model doesn't support are hidden.
 */
function effortOptions(model: ModelConfig): SelectorOption[] {
  return [
    { id: "default", name: "Default" },
    ...getModelControlsFor(model).efforts.map((effort) => ({
      id: effort,
      name: effortLabel(effort),
    })),
  ];
}

function contextOptions(model: ModelConfig): SelectorOption[] {
  return getContextOptions(model, DEFAULT_CONTEXT_LENGTH).map((tokens) => ({
    id: String(tokens),
    name: formatContextLength(tokens),
  }));
}

function configuredContext(model: ModelConfig): number {
  return (
    model.defaultCompletionOptions?.contextLength ?? DEFAULT_CONTEXT_LENGTH
  );
}

/**
 * The model menu (experimental): the current model plus its settings
 * (effort, readable thinking, fast mode, context window), like the model
 * picker in Cursor. Rows a model doesn't support are hidden.
 */
export function ModelMenu({ onSelectModel, onCancel }: ModelMenuProps) {
  const [view, setView] = useState<MenuView>("main");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [subIndex, setSubIndex] = useState(0);
  const [, setVersion] = useState(0);

  const model = currentModel();
  const rows = buildRows(model);
  const settings = model ? getModelSettings(model) : undefined;
  const currentEffort = settings?.effort ?? "default";
  const currentContext = model
    ? String(settings?.contextLength ?? configuredContext(model))
    : "";

  const openSubmenu = (
    next: MenuView,
    options: SelectorOption[],
    currentId: string,
  ) => {
    setSubIndex(
      Math.max(
        0,
        options.findIndex((option) => option.id === currentId),
      ),
    );
    setView(next);
  };
  const backToMain = () => setView("main");

  if (view === "models") {
    return <ModelSelector onSelect={onSelectModel} onCancel={backToMain} />;
  }

  if (view === "effort" && model) {
    const experimental = getModelControlsFor(model).experimental;
    return (
      <Selector
        title={`Effort for ${model.name || model.model}${experimental ? " (best guess for this model)" : ""}`}
        options={effortOptions(model)}
        selectedIndex={subIndex}
        loading={false}
        error={null}
        currentId={currentEffort}
        onSelect={(option) => {
          updateModelSettings(model, {
            effort: option.id === "default" ? undefined : option.id,
          });
          backToMain();
        }}
        onCancel={backToMain}
        onNavigate={setSubIndex}
      />
    );
  }

  if (view === "context" && model) {
    return (
      <Selector
        title="Context window (when the CLI compacts the conversation)"
        options={contextOptions(model)}
        selectedIndex={subIndex}
        loading={false}
        error={null}
        currentId={currentContext}
        onSelect={(option) => {
          const tokens = Number(option.id);
          updateModelSettings(model, {
            contextLength:
              tokens === configuredContext(model) ? undefined : tokens,
          });
          backToMain();
        }}
        onCancel={backToMain}
        onNavigate={setSubIndex}
      />
    );
  }

  const selectRow = (row: MenuRow) => {
    if (row.id === "model") {
      setView("models");
      return;
    }
    if (!model) return;
    switch (row.id) {
      case "effort":
        openSubmenu("effort", effortOptions(model), currentEffort);
        break;
      case "context":
        openSubmenu("context", contextOptions(model), currentContext);
        break;
      case "thinking-needs-effort":
        openSubmenu("effort", effortOptions(model), currentEffort);
        break;
      case "thinking":
        updateModelSettings(model, {
          showThinking: settings?.showThinking === false,
        });
        setVersion((version) => version + 1);
        break;
      case "fast":
        updateModelSettings(model, { fast: !settings?.fast });
        setVersion((version) => version + 1);
        break;
    }
  };

  return (
    <Selector
      title="Model settings (experimental)"
      options={rows}
      selectedIndex={Math.min(selectedIndex, rows.length - 1)}
      loading={false}
      error={null}
      onSelect={selectRow}
      onCancel={onCancel}
      onNavigate={setSelectedIndex}
      renderOption={(row, isSelected) => (
        <Text color={isSelected ? "blue" : "white"} bold={isSelected}>
          {isSelected ? "➤ " : "  "}
          {row.name.padEnd(16)}
          <Text color="gray">
            {row.value}
            {row.opensSubmenu ? " ›" : ""}
          </Text>
        </Text>
      )}
    />
  );
}

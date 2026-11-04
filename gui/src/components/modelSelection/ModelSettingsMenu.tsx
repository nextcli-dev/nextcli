import {
  BoltIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "@heroicons/react/24/outline";
import type { SerializedModelControls } from "core";
import type {
  ModelSettingsPatch,
  ResolvedModelSettings,
} from "core/llm/modelSettings";
import { Divider } from "../ui/Divider";
import { MENU_ITEM_CLASS } from "./ModelList";
import {
  effortLabel,
  formatContextLength,
  THINKING_MODES,
  thinkingDescription,
  thinkingLabel,
  visibleSettingRows,
} from "./modelMenuLabels";

export type SettingsView = "root" | "thinking" | "effort" | "context";

interface ModelSettingsMenuProps {
  modelTitle: string;
  controls: SerializedModelControls;
  settings: ResolvedModelSettings | undefined;
  view: SettingsView;
  onView: (view: SettingsView | "models") => void;
  onChange: (patch: ModelSettingsPatch) => void;
}

function SettingRow({
  id,
  label,
  value,
  chip,
  disabled,
  onClick,
  toggle,
}: {
  id: string;
  label: string;
  value?: string;
  chip?: string;
  disabled?: boolean;
  onClick: () => void;
  toggle?: boolean;
}) {
  return (
    <button
      type="button"
      data-menu-item
      data-row={id}
      role={toggle === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={toggle}
      aria-haspopup={toggle === undefined ? "menu" : undefined}
      aria-disabled={disabled}
      onClick={() => !disabled && onClick()}
      className={`${MENU_ITEM_CLASS} justify-between ${
        disabled ? "text-description-muted cursor-default" : ""
      }`}
    >
      <span className="whitespace-nowrap">{label}</span>
      {toggle !== undefined ? (
        <span
          aria-hidden="true"
          className={`relative h-3 w-[22px] flex-shrink-0 rounded-full transition-colors ${
            toggle ? "bg-primary" : "bg-input-border"
          }`}
        >
          <span
            className={`absolute top-0.5 h-2 w-2 rounded-full bg-white transition-transform ${
              toggle ? "left-0.5 translate-x-2.5" : "left-0.5"
            }`}
          />
        </span>
      ) : (
        <span className="text-description flex min-w-0 items-center gap-1">
          {chip && (
            <span className="bg-badge text-badge-foreground rounded px-1 text-[9px] leading-[14px]">
              {chip}
            </span>
          )}
          <span className="line-clamp-1 max-w-[110px]">{value}</span>
          {!disabled && (
            <ChevronRightIcon className="h-2.5 w-2.5 flex-shrink-0" />
          )}
        </span>
      )}
    </button>
  );
}

function SubmenuOption({
  label,
  description,
  selected,
  disabled,
  onClick,
}: {
  label: string;
  description?: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-menu-item
      role="menuitemradio"
      aria-checked={selected}
      aria-disabled={disabled}
      title={disabled ? description : undefined}
      onClick={() => !disabled && onClick()}
      className={`${MENU_ITEM_CLASS} ${disabled ? "cursor-default opacity-50" : ""}`}
    >
      <span className="flex w-3 flex-shrink-0">
        {selected && <CheckIcon className="h-3 w-3" />}
      </span>
      <span className="grid min-w-0">
        <span>{label}</span>
        {description && (
          <span className="text-description whitespace-normal text-[10px]">
            {description}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * The settings view of the model menu: Fast, Thinking, Effort and Context
 * for the selected model, each shown only when the model supports it, and
 * the Model row that opens the model list. Choices change the setting in
 * place and keep the menu open.
 */
export function ModelSettingsMenu({
  modelTitle,
  controls,
  settings,
  view,
  onView,
  onChange,
}: ModelSettingsMenuProps) {
  const rows = visibleSettingRows(controls);
  const thinking = settings?.thinking;
  const effortBlocked = thinking === "off" && controls.effortNeedsThinking;

  if (view !== "root") {
    const title = {
      thinking: "Thinking",
      effort: "Effort",
      context: "Context",
    }[view];
    const choose = (patch: ModelSettingsPatch) => {
      onChange(patch);
      onView("root");
    };
    return (
      <div role="group" aria-label={title}>
        <div className="flex items-center gap-1 px-1.5 py-1">
          <button
            type="button"
            aria-label="Back"
            data-menu-item
            onClick={() => onView("root")}
            className="text-description hover:bg-list-active focus-visible:bg-list-active flex h-5 w-5 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 outline-none"
          >
            <ChevronLeftIcon className="h-3 w-3" />
          </button>
          <span className="text-description text-xs font-medium">{title}</span>
        </div>
        {view === "thinking" &&
          THINKING_MODES.map((mode) => {
            const available = controls.thinkingModes.includes(mode);
            return (
              <SubmenuOption
                key={mode}
                label={thinkingLabel(mode)}
                description={
                  available
                    ? thinkingDescription(mode)
                    : controls.thinkingUnavailable[mode]
                }
                selected={thinking === mode}
                disabled={!available}
                onClick={() => choose({ thinking: mode })}
              />
            );
          })}
        {view === "effort" && (
          <>
            <SubmenuOption
              label="Default"
              description="The provider's default level"
              selected={!settings?.stored.effort}
              onClick={() => choose({ effort: null })}
            />
            {controls.efforts.map((effort) => (
              <SubmenuOption
                key={effort}
                label={effortLabel(effort)}
                selected={settings?.stored.effort === effort}
                onClick={() => choose({ effort })}
              />
            ))}
          </>
        )}
        {view === "context" &&
          controls.contextOptions.map((tokens) => (
            <SubmenuOption
              key={tokens}
              label={formatContextLength(tokens)}
              description={
                tokens === controls.defaultContextLength
                  ? "From config"
                  : tokens === controls.maxContextLength
                    ? "Model maximum"
                    : undefined
              }
              selected={settings?.contextLength === tokens}
              onClick={() =>
                choose({
                  contextLength:
                    tokens === controls.defaultContextLength ? null : tokens,
                })
              }
            />
          ))}
      </div>
    );
  }

  return (
    <div role="group" aria-label="Model settings">
      {rows.fast && (
        <SettingRow
          id="fast"
          label="Fast"
          toggle={!!settings?.fast}
          onClick={() => onChange({ fast: settings?.fast ? null : true })}
        />
      )}
      {rows.thinking && (
        <SettingRow
          id="thinking"
          label="Thinking"
          value={thinkingLabel(thinking)}
          onClick={() => onView("thinking")}
        />
      )}
      {rows.effort && (
        <>
          <SettingRow
            id="effort"
            label="Effort"
            value={
              effortBlocked ? "Needs thinking" : effortLabel(settings?.effort)
            }
            chip={controls.experimental ? "guess" : undefined}
            disabled={effortBlocked}
            onClick={() => onView("effort")}
          />
          {effortBlocked && (
            <div className="text-description px-2 pb-1 text-[10px]">
              Effort only applies while the model thinks.
            </div>
          )}
        </>
      )}
      {rows.context && settings && (
        <SettingRow
          id="context"
          label="Context"
          value={formatContextLength(settings.contextLength)}
          onClick={() => onView("context")}
        />
      )}
      {(rows.fast || rows.thinking || rows.effort || rows.context) && (
        <Divider className="!my-0" />
      )}
      <SettingRow
        id="models"
        label="Model"
        value={modelTitle}
        onClick={() => onView("models")}
      />
    </div>
  );
}

export function FastIcon() {
  return <BoltIcon className="h-2.5 w-2.5 flex-shrink-0 text-yellow-500" />;
}

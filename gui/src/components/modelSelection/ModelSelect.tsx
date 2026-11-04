import { ChevronDownIcon, NoSymbolIcon } from "@heroicons/react/24/outline";
import { ModelDescription } from "core";
import type { ModelSettingsPatch } from "core/llm/modelSettings";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { defaultBorderRadius, vscCommandCenterInactiveBorder } from "..";
import { useAuth } from "../../context/Auth";
import { AddModelForm } from "../../forms/AddModelForm";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  modelSettingsKey,
  selectModelSettings,
} from "../../redux/slices/modelSettingsSlice";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";
import { updateModelSettings } from "../../redux/thunks/modelSettings";
import { updateSelectedModelByRole } from "../../redux/thunks/updateSelectedModelByRole";
import { isMetaEquivalentKeyPressed } from "../../util";
import { CONFIG_ROUTES } from "../../util/navigation";
import { Popover, PopoverButton, PopoverPanel, useFontSize } from "../ui";
import { ModelList, ModelListOption } from "./ModelList";
import { FastIcon, ModelSettingsMenu, SettingsView } from "./ModelSettingsMenu";
import { effortLabel, visibleSettingRows } from "./modelMenuLabels";

type MenuView = SettingsView | "models";

function modelSelectTitle(model: any): string {
  if (model?.title) return model?.title;
  if (model?.model !== undefined && model?.model.trim() !== "") {
    if (model?.class_name) {
      return `${model?.class_name} - ${model?.model}`;
    }
    return model?.model;
  }
  return model?.class_name;
}

/** Alphabetical, with models missing an API key last */
function sortOptions(models: ModelDescription[]): ModelListOption[] {
  const options = models
    .map((model) => ({
      value: model.title,
      title: modelSelectTitle(model),
      apiKey: model.apiKey,
      isAutoDetected: model.isFromAutoDetect,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
  return [
    ...options.filter((option) => option.apiKey !== ""),
    ...options.filter((option) => option.apiKey === ""),
  ];
}

/** Moves focus between menu rows with the arrow keys */
function moveFocus(panel: HTMLElement | null, step: number) {
  if (!panel) return;
  const items = Array.from(
    panel.querySelectorAll<HTMLElement>("[data-menu-item]"),
  );
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next =
    index === -1
      ? step > 0
        ? 0
        : items.length - 1
      : (index + step + items.length) % items.length;
  items[next].focus();
}

/** Focuses the selected row, else the first one, when a view opens */
function FocusOnView({
  view,
  panelRef,
}: {
  view: MenuView;
  panelRef: React.RefObject<HTMLDivElement>;
}) {
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    // In a list, start on the current choice; in the settings, at the top
    const target =
      (view !== "root"
        ? panel.querySelector<HTMLElement>(
            "[data-menu-item][aria-checked='true']",
          )
        : null) ?? panel.querySelector<HTMLElement>("[data-menu-item]");
    target?.focus({ preventScroll: true });
  }, [view, panelRef]);
  return null;
}

/**
 * The model menu in the chat input. The trigger shows the model, its effort,
 * fast mode and whether thinking is off. The menu shows the model's
 * settings (Fast, Thinking, Effort, Context) and a Model row that opens the
 * model list; in Edit mode it shows only the list. It stays open while
 * settings change.
 */
function ModelSelect() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { selectedProfile } = useAuth();
  const menuFont = useFontSize(-3);
  const panelRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<MenuView>("root");

  const isInEdit = useAppSelector((store) => store.session.isInEdit);
  const config = useAppSelector((state) => state.config.config);
  const isConfigLoading = useAppSelector((state) => state.config.loading);

  let selectedModel: ModelDescription | null = null;
  let allModels: ModelDescription[] | null = null;
  if (isInEdit) {
    allModels = config.modelsByRole.edit;
    selectedModel = config.selectedModelByRole.edit;
  }
  if (!selectedModel) {
    selectedModel = config.selectedModelByRole.chat;
  }
  if (!allModels || allModels.length === 0) {
    allModels = config.modelsByRole.chat;
  }

  const settings = useAppSelector((state) =>
    selectModelSettings(state, selectedModel),
  );
  const options = useMemo(() => sortOptions(allModels ?? []), [allModels]);
  const controls = selectedModel?.controls;
  const rows = visibleSettingRows(controls);
  const hasSettings =
    !isInEdit && (rows.fast || rows.thinking || rows.effort || rows.context);

  function selectModel(title: string) {
    if (title === selectedModel?.title) return;
    void dispatch(
      updateSelectedModelByRole({
        selectedProfile,
        role: isInEdit ? "edit" : "chat",
        modelTitle: title,
      }),
    );
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "'" &&
        isMetaEquivalentKeyPressed(event as any) &&
        !event.shiftKey // To prevent collisions w/ assistant toggle logic
      ) {
        if (!selectedProfile) {
          return;
        }
        const enabled = options.filter((option) => option.apiKey !== "");
        if (enabled.length === 0) return;
        const currentIndex = enabled.findIndex(
          (option) => option.value === selectedModel?.title,
        );
        const next = enabled[(currentIndex + 1) % enabled.length];
        void dispatch(
          updateSelectedModelByRole({
            selectedProfile,
            role: "chat",
            modelTitle: next.value,
          }),
        );
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [options, selectedModel, selectedProfile]);

  function changeSettings(patch: ModelSettingsPatch) {
    if (!selectedModel) return;
    void dispatch(
      updateModelSettings({ key: modelSettingsKey(selectedModel), patch }),
    );
  }

  function openAddModel(close: () => void) {
    close();
    dispatch(setShowDialog(true));
    dispatch(
      setDialogMessage(
        <AddModelForm
          onDone={() => {
            dispatch(setShowDialog(false));
          }}
        />,
      ),
    );
  }

  function openConfig(close: () => void) {
    close();
    navigate(CONFIG_ROUTES.MODELS);
  }

  const effort =
    settings?.effort &&
    !(settings.thinking === "off" && controls?.effortNeedsThinking)
      ? settings.effort
      : undefined;
  const showListOnly = !hasSettings;
  const currentView: MenuView = showListOnly ? "models" : view;

  return (
    <Popover className="relative flex">
      {({ open }) => (
        <>
          <PopoverButton
            data-testid="model-select-button"
            onClick={() => setView("root")}
            className="text-description m-0 flex h-[18px] min-w-0 cursor-pointer items-center gap-1 border-none bg-transparent px-1 py-0.5 text-left transition-colors duration-200"
            style={{ fontSize: menuFont, borderRadius: defaultBorderRadius }}
          >
            <span className="line-clamp-1 min-w-0 break-all hover:brightness-110">
              {modelSelectTitle(selectedModel) || "Select model"}
            </span>
            {!isInEdit && effort && (
              <span
                data-testid="model-select-effort"
                className="text-description-muted whitespace-nowrap"
              >
                {effortLabel(effort)}
              </span>
            )}
            {!isInEdit && settings?.fast && (
              <span data-testid="model-select-fast" aria-label="Fast mode on">
                <FastIcon />
              </span>
            )}
            {!isInEdit && settings?.thinking === "off" && (
              <span
                data-testid="model-select-thinking-off"
                aria-label="Thinking off"
                title="Thinking off"
              >
                <NoSymbolIcon className="text-description-muted h-2.5 w-2.5 flex-shrink-0" />
              </span>
            )}
            <ChevronDownIcon
              className="hidden h-2 w-2 flex-shrink-0 hover:brightness-110 min-[200px]:flex"
              aria-hidden="true"
            />
          </PopoverButton>
          {open && (
            <PopoverPanel
              ref={panelRef}
              anchor="bottom start"
              role="menu"
              data-testid="model-select-menu"
              className="bg-vsc-input-background flex w-max min-w-[160px] max-w-[240px] flex-col overflow-auto px-0 shadow-md"
              style={{
                border: `1px solid ${vscCommandCenterInactiveBorder}`,
                fontSize: menuFont,
                borderRadius: defaultBorderRadius,
                zIndex: 200000,
              }}
            >
              {({ close }) => (
                <div
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      moveFocus(
                        panelRef.current,
                        e.key === "ArrowDown" ? 1 : -1,
                      );
                    } else if (e.key === "ArrowRight") {
                      const row = (document.activeElement as HTMLElement | null)
                        ?.dataset.row;
                      if (row && row !== "fast" && currentView === "root") {
                        e.preventDefault();
                        (document.activeElement as HTMLElement).click();
                      }
                    } else if (
                      e.key === "ArrowLeft" &&
                      currentView !== "root"
                    ) {
                      if (!showListOnly) {
                        e.preventDefault();
                        setView("root");
                      }
                    } else if (
                      e.key === "Escape" &&
                      currentView !== "root" &&
                      !showListOnly
                    ) {
                      // Escape goes back first; from the main view it closes
                      e.preventDefault();
                      e.stopPropagation();
                      setView("root");
                    }
                  }}
                >
                  <FocusOnView view={currentView} panelRef={panelRef} />
                  {currentView === "models" ? (
                    <ModelList
                      options={options}
                      selectedTitle={selectedModel?.title}
                      isLoading={isConfigLoading}
                      onBack={showListOnly ? undefined : () => setView("root")}
                      onSelect={(title) => {
                        selectModel(title);
                        // Keep the menu open on the new model's settings
                        if (showListOnly) close();
                        else setView("root");
                      }}
                      onConfigure={() => openConfig(close)}
                      onAddModel={() => openAddModel(close)}
                    />
                  ) : (
                    controls &&
                    selectedModel && (
                      <ModelSettingsMenu
                        modelTitle={modelSelectTitle(selectedModel)}
                        controls={controls}
                        settings={settings}
                        view={currentView}
                        onView={setView}
                        onChange={changeSettings}
                      />
                    )
                  )}
                </div>
              )}
            </PopoverPanel>
          )}
        </>
      )}
    </Popover>
  );
}

export default ModelSelect;

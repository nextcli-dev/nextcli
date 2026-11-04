import {
  ArrowPathIcon,
  ChevronLeftIcon,
  Cog6ToothIcon,
  CubeIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import { getMetaKeyLabel } from "../../util";
import { useFontSize } from "../ui";
import { Divider } from "../ui/Divider";

export interface ModelListOption {
  value: string;
  title: string;
  apiKey?: string;
  isAutoDetected?: boolean;
}

/** Classes shared by every row in the model menu */
export const MENU_ITEM_CLASS =
  "text-foreground flex w-full cursor-pointer select-none items-center gap-2 border-none bg-transparent px-2 py-1 text-left outline-none hover:bg-list-active hover:text-list-active-foreground focus-visible:bg-list-active focus-visible:text-list-active-foreground";

interface ModelListProps {
  options: ModelListOption[];
  selectedTitle?: string;
  isLoading: boolean;
  onSelect: (title: string) => void;
  onConfigure: () => void;
  onAddModel: () => void;
  /** Shows a back arrow to the settings view */
  onBack?: () => void;
}

/**
 * The model list: the same rows, order, tags, gear, "Add Chat model" and
 * shortcut hint as the picker has always had.
 */
export function ModelList({
  options,
  selectedTitle,
  isLoading,
  onSelect,
  onConfigure,
  onAddModel,
  onBack,
}: ModelListProps) {
  const tinyFont = useFontSize(-4);

  return (
    <div role="group" aria-label="Models">
      <div className="flex items-center justify-between gap-1 px-1.5 py-1">
        <div className="flex items-center gap-1">
          {onBack && (
            <button
              type="button"
              aria-label="Back"
              data-menu-item
              onClick={onBack}
              className="text-description hover:bg-list-active focus-visible:bg-list-active flex h-5 w-5 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 outline-none"
            >
              <ChevronLeftIcon className="h-3 w-3" />
            </button>
          )}
          <span className="text-description text-xs font-medium">Models</span>
        </div>
        <button
          type="button"
          aria-label="Configure models"
          onClick={onConfigure}
          className="text-description hover:bg-list-active flex h-5 w-5 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0"
        >
          <Cog6ToothIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="no-scrollbar max-h-[300px] overflow-y-auto">
        {isLoading ? (
          <div className="text-description flex items-center gap-2 px-2 pb-2 pt-1 text-xs">
            <ArrowPathIcon className="animate-spin-slow h-3 w-3" />
            <span>Loading config</span>
          </div>
        ) : options.length === 0 ? (
          <div className="text-description-muted px-2 py-4 text-center text-sm">
            No models configured
          </div>
        ) : (
          options.map((option) => {
            const missingKey = option.apiKey === "";
            const selected = option.value === selectedTitle;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                aria-disabled={missingKey}
                data-menu-item
                onClick={() => !missingKey && onSelect(option.value)}
                className={`group ${MENU_ITEM_CLASS} justify-between ${
                  selected ? "bg-list-active text-list-active-foreground" : ""
                } ${missingKey ? "cursor-default opacity-50" : ""}`}
              >
                <span className="flex items-center gap-2 py-0.5">
                  <CubeIcon className="h-3 w-3 flex-shrink-0" />
                  <span className="line-clamp-1">
                    {option.title}
                    {option.isAutoDetected && (
                      <span className="text-description-muted ml-1.5 text-[10px] italic">
                        (autodetected)
                      </span>
                    )}
                    {missingKey && (
                      <span className="ml-1.5 text-[10px] italic">
                        (Missing API key)
                      </span>
                    )}
                  </span>
                </span>
                <span
                  role="button"
                  aria-label={`Configure ${option.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onConfigure();
                  }}
                  className="text-description hover:text-foreground ml-5 flex h-4 w-4 items-center opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <Cog6ToothIcon className="h-3.5 w-3.5" />
                </span>
              </button>
            );
          })
        )}
      </div>

      {!isLoading && (
        <>
          <Divider className="!mb-0" />
          <button
            type="button"
            role="menuitem"
            data-menu-item
            onClick={onAddModel}
            className={`${MENU_ITEM_CLASS} text-description text-2xs px-2 py-2`}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            Add Chat model
          </button>
          <Divider className="!my-0" />
          <div className="text-description flex items-center justify-start p-2">
            <span className="block" style={{ fontSize: tinyFont }}>
              <code>{getMetaKeyLabel()}'</code> to toggle model
            </span>
          </div>
        </>
      )}
    </div>
  );
}

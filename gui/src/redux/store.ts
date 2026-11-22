import {
  combineReducers,
  configureStore,
  ThunkDispatch,
  UnknownAction,
} from "@reduxjs/toolkit";
import {
  createMigrate,
  MigrationManifest,
  persistReducer,
  persistStore,
} from "redux-persist";
import { createFilter } from "redux-persist-transform-filter";
import autoMergeLevel2 from "redux-persist/lib/stateReconciler/autoMergeLevel2";
import storage from "redux-persist/lib/storage";
import { v4 as uuidv4 } from "uuid";
import { IdeMessenger, IIdeMessenger } from "../context/IdeMessenger";
import configReducer from "./slices/configSlice";
import editModeStateReducer from "./slices/editState";
import modelSettingsReducer from "./slices/modelSettingsSlice";
import { profilesReducer } from "./slices/profilesSlice";
import sessionReducer from "./slices/sessionSlice";
import tabsReducer from "./slices/tabsSlice";
import uiReducer from "./slices/uiSlice";

const sliceReducer = combineReducers({
  session: sessionReducer,
  ui: uiReducer,
  editModeState: editModeStateReducer,
  config: configReducer,
  tabs: tabsReducer,
  profiles: profilesReducer,
  modelSettings: modelSettingsReducer,
});

/**
 * Drops the in-memory state that a crash can replay. Config and model
 * settings stay: they are loaded from the host, and the listeners that
 * fetch them do not run again after recovery.
 */
export const ROOT_RESET = "root/reset";

export function resetRootState(): UnknownAction {
  return { type: ROOT_RESET };
}

function rootReducer(
  state: ReturnType<typeof sliceReducer> | undefined,
  action: UnknownAction,
): ReturnType<typeof sliceReducer> {
  if (action.type !== ROOT_RESET) {
    return sliceReducer(state, action);
  }
  // Abort the live stream, then hand the recovered session a new controller
  // and id. The slice initial state shares one controller and that object
  // is frozen, so the state returned below must not keep it.
  state?.session.streamAborter.abort();
  const next = sliceReducer(undefined, action);
  return {
    ...next,
    config: state?.config ?? next.config,
    modelSettings: state?.modelSettings ?? next.modelSettings,
    session: {
      ...next.session,
      id: uuidv4(),
      streamAborter: new AbortController(),
    },
  };
}

const saveSubsetFilters = [
  createFilter("session", [
    "id",
    "lastSessionId",
    "title",

    // Persist edit mode in case closes in middle
    "mode",

    // higher risk to persist
    // codeBlockApplyStates
    // symbols
  ]),
  createFilter("editModeState", [
    "returnToMode",
    "lastNonEditSessionWasEmpty",
    "codeToEdit",
  ]),
  createFilter("config", []),
  createFilter("ui", [
    "toolSettings",
    "toolGroupSettings",
    "ruleSettings",
    "reasoningSettings",
    "trustedFetchHosts",
  ]),
  // Saved on the host (shared with the CLI), so never persisted here
  createFilter("modelSettings", []),
  createFilter("tabs", ["tabs"]),
  createFilter("profiles", ["preferencesByProfileId", "selectedProfileId"]),
];

const migrations: MigrationManifest = {
  "0": (state) => {
    const oldState = state as any;

    return {
      config: {
        defaultModelTitle: oldState?.state?.defaultModelTitle ?? undefined,
      },
      session: {
        id: oldState?.state?.sessionId ?? "",
      },
      tabs: {
        tabs: [
          {
            id:
              Date.now().toString(36) + Math.random().toString(36).substring(2),
            title: "Chat 1",
            isActive: true,
          },
        ],
      },
      _persist: oldState?._persist,
    };
  },
};

const persistConfig = {
  version: 1,
  key: "root",
  storage,
  transforms: [...saveSubsetFilters],
  stateReconciler: autoMergeLevel2,
  migrate: createMigrate(migrations, { debug: false }),
};

const persistedReducer = persistReducer<ReturnType<typeof rootReducer>>(
  persistConfig,
  rootReducer,
);

export function setupStore(options: { ideMessenger?: IIdeMessenger }) {
  const ideMessenger = options.ideMessenger ?? new IdeMessenger();

  return configureStore({
    // persistedReducer causes type errors with async thunks
    reducer: persistedReducer as unknown as typeof rootReducer,
    // reducer: rootReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: false,
        thunk: {
          extraArgument: {
            ideMessenger,
          },
        },
      }),
  });
}

export type ThunkExtrasType = { ideMessenger: IIdeMessenger };

export type ThunkApiType = {
  state: RootState;
  extra: ThunkExtrasType;
};

export type AppThunkDispatch = ThunkDispatch<
  RootState,
  ThunkExtrasType,
  UnknownAction
>;

export const store = setupStore({});

export type RootState = ReturnType<typeof rootReducer>;

export type AppDispatch = typeof store.dispatch;

export const persistor = persistStore(store);

import { useAppDispatch, useAppSelector } from "../redux/hooks";
import { deleteCompaction } from "../redux/slices/sessionSlice";
import {
  cancelCompaction,
  compactConversation,
} from "../redux/thunks/compactConversation";
import { saveCurrentSession } from "../redux/thunks/session";
import { isTurnOver } from "../undo/turnSnapshot";

export const useCompactConversation = () => {
  const dispatch = useAppDispatch();

  return async (index: number) => {
    await dispatch(compactConversation({ index }));
  };
};

/** Whether the message at `index` can be compacted: the turn is over and it isn't compacting */
export const useCanCompact = (index: number) =>
  useAppSelector((state) => {
    const messageId = state.session.history[index]?.message.id;
    return (
      !!messageId &&
      !state.session.compactionLoading[messageId] &&
      isTurnOver(state)
    );
  });

export const useCancelCompaction = () => {
  const dispatch = useAppDispatch();

  return (messageId: string) => {
    void dispatch(cancelCompaction({ messageId }));
  };
};

export const useDeleteCompaction = () => {
  const dispatch = useAppDispatch();

  return (messageId: string) => {
    // Update local state and save to persistence
    dispatch(deleteCompaction({ messageId }));
    void dispatch(
      saveCurrentSession({
        openNewSession: false,
        generateTitle: false,
      }),
    );
  };
};

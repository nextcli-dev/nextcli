import { useAppDispatch } from "../redux/hooks";
import { deleteCompaction } from "../redux/slices/sessionSlice";
import {
  cancelCompaction,
  compactConversation,
} from "../redux/thunks/compactConversation";
import { saveCurrentSession } from "../redux/thunks/session";

export const useCompactConversation = () => {
  const dispatch = useAppDispatch();

  return async (index: number) => {
    await dispatch(compactConversation({ index }));
  };
};

export const useCancelCompaction = () => {
  const dispatch = useAppDispatch();

  return (index: number) => {
    void dispatch(cancelCompaction({ index }));
  };
};

export const useDeleteCompaction = () => {
  const dispatch = useAppDispatch();

  return (index: number) => {
    // Update local state and save to persistence
    dispatch(deleteCompaction(index));
    void dispatch(
      saveCurrentSession({
        openNewSession: false,
        generateTitle: false,
      }),
    );
  };
};

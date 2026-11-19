import { useEffect, useMemo, useRef } from "react";
import { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionSlice";

/** How close to the end still counts as "at the bottom", in pixels */
export const STICK_THRESHOLD_PX = 16;

function getNumUserMsgs(history: ChatHistoryItemWithMessageId[]) {
  return history.filter((msg) => msg.message.role === "user").length;
}

/**
 * Keeps the chat at the end while new content grows (streamed answers,
 * inline reasoning, tool output), but only while the user is there.
 * Scrolling up switches to manual; scrolling back to the end switches to
 * auto again. A new user message always returns to the end.
 */
export const useAutoScroll = (
  ref: React.RefObject<HTMLDivElement>,
  history: ChatHistoryItemWithMessageId[],
) => {
  // A ref, not state: scrolling must not re-create the observers
  const stickRef = useRef(true);
  const numUserMsgs = useMemo(() => getNumUserMsgs(history), [history]);
  const hasHistory = history.length > 0;

  useEffect(() => {
    stickRef.current = true;
    const elem = ref.current;
    if (elem) {
      elem.scrollTop = elem.scrollHeight;
    }
  }, [numUserMsgs]);

  useEffect(() => {
    const elem = ref.current;
    if (!elem || !hasHistory) return;

    let lastScrollTop = elem.scrollTop;

    const scrollToEnd = () => {
      if (stickRef.current) {
        elem.scrollTop = elem.scrollHeight;
        lastScrollTop = elem.scrollTop;
      }
    };

    // Only the user scrolling up lets go. Our own scrollToEnd only moves
    // down, but its scroll event can fire after more content rendered, when
    // the view is no longer at the end; that must not switch auto off.
    const handleScroll = () => {
      const scrollTop = elem.scrollTop;
      const distance = elem.scrollHeight - scrollTop - elem.clientHeight;
      if (distance <= STICK_THRESHOLD_PX) {
        stickRef.current = true;
      } else if (scrollTop < lastScrollTop) {
        stickRef.current = false;
      }
      lastScrollTop = scrollTop;
    };

    // A wheel up lets go at once, before content added in the same frame
    // can pull the view back down
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        stickRef.current = false;
      }
    };

    const resizeObserver = new ResizeObserver(scrollToEnd);
    resizeObserver.observe(elem);
    Array.from(elem.children).forEach((child) => resizeObserver.observe(child));

    // Watch items as they are added, not only when the effect re-runs
    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) {
            resizeObserver.observe(node);
          }
        });
      }
      scrollToEnd();
    });
    mutationObserver.observe(elem, { childList: true });

    elem.addEventListener("scroll", handleScroll);
    elem.addEventListener("wheel", handleWheel, { passive: true });

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      elem.removeEventListener("scroll", handleScroll);
      elem.removeEventListener("wheel", handleWheel);
    };
  }, [ref, hasHistory]);
};

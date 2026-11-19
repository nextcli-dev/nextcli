import { useEffect, useMemo, useRef } from "react";
import { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionSlice";

/** How close to the end still counts as "at the bottom", in pixels */
export const STICK_THRESHOLD_PX = 16;

function distanceToEnd(elem: HTMLElement) {
  return elem.scrollHeight - elem.scrollTop - elem.clientHeight;
}

/**
 * Whether a box between the wheel's target and the chat scrolls vertically
 * and can still move up, so it takes a wheel up instead of the chat.
 * Boxes that only scroll sideways (terminal output, code) don't count.
 */
function nestedScrollerTakes(target: EventTarget | null, chat: HTMLElement) {
  for (
    let node = target instanceof Element ? target : null;
    node && node !== chat;
    node = node.parentElement
  ) {
    if (node.scrollTop > 0) {
      const { overflowY } = getComputedStyle(node);
      if (overflowY === "auto" || overflowY === "scroll") return true;
    }
  }
  return false;
}

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
      if (distanceToEnd(elem) <= STICK_THRESHOLD_PX) {
        stickRef.current = true;
      } else if (scrollTop < lastScrollTop) {
        stickRef.current = false;
      }
      lastScrollTop = scrollTop;
    };

    // A wheel up that scrolls the chat lets go at once, before content
    // added in the same frame can pull the view back down. Wheels bubble, so
    // one that a nested box takes (live reasoning) or that has nothing to
    // move (a chat at its top) leaves auto alone: no scroll event follows
    // either, and the user didn't scroll away from the reply.
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        if (elem.scrollTop > 0 && !nestedScrollerTakes(event.target, elem)) {
          stickRef.current = false;
        }
      } else if (
        event.deltaY > 0 &&
        distanceToEnd(elem) <= STICK_THRESHOLD_PX
      ) {
        // A wheel down at the end can't scroll, so no scroll event would
        // resume auto there
        stickRef.current = true;
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

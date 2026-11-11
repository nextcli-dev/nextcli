import { useContext } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { setInlineErrorMessage } from "../../redux/slices/sessionSlice";
import { streamResponseThunk } from "../../redux/thunks/streamResponse";
import {
  EMPTY_ANSWER_PROMPT,
  type NoAnswerNotice,
  noAnswerText,
} from "../../redux/util/noAnswerNotice";

export type InlineErrorMessageType = "out-of-context" | NoAnswerNotice;

function NoticeFrame({
  text,
  textClassName,
  children,
}: {
  text: string;
  textClassName: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`border-border relative m-2 flex flex-col rounded-md border border-solid bg-transparent p-4`}
    >
      <p className={`thread-message text-center ${textClassName}`}>{text}</p>
      <div className="text-description flex flex-row flex-wrap items-center justify-center gap-1.5 px-3">
        {children}
      </div>
    </div>
  );
}

function Action({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <span
      role="button"
      className="cursor-pointer text-xs hover:underline"
      onClick={onClick}
    >
      {children}
    </span>
  );
}

export default function InlineErrorMessage() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const inlineErrorMessage = useAppSelector(
    (state) => state.session.inlineErrorMessage,
  );

  const openConfig = () => {
    ideMessenger.post("config/openProfile", {
      profileId: undefined,
    });
  };
  const hide = () => {
    dispatch(setInlineErrorMessage(undefined));
  };

  if (inlineErrorMessage === "out-of-context") {
    return (
      <NoticeFrame
        text="Message exceeds context limit."
        textClassName="text-error"
      >
        <Action onClick={openConfig}>
          <span className="xs:flex hidden">Open config</span>
          <span className="xs:hidden">Config</span>
        </Action>
        |<Action onClick={hide}>Hide</Action>
      </NoticeFrame>
    );
  }

  if (inlineErrorMessage?.kind === "no-answer") {
    const askForAnswer = () => {
      void dispatch(
        streamResponseThunk({
          editorState: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: EMPTY_ANSWER_PROMPT }],
              },
            ],
          },
          modifiers: { noContext: true, useCodebase: false },
        }),
      );
    };
    return (
      <NoticeFrame
        text={noAnswerText(inlineErrorMessage)}
        textClassName="text-warning"
      >
        <Action onClick={askForAnswer}>Ask for the answer</Action>|
        {inlineErrorMessage.reason === "length" && (
          <>
            <Action onClick={openConfig}>Open config</Action>|
          </>
        )}
        <Action onClick={hide}>Hide</Action>
      </NoticeFrame>
    );
  }

  return null;
}

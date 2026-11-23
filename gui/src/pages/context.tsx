import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { useAppSelector } from "../redux/hooks";
import { ROUTES } from "../util/navigation";

type Segment = {
  id: string;
  label: string;
  tokens: number;
  source: string;
  children?: Segment[];
};

function rows(segments: Segment[], indent = 0): JSX.Element[] {
  return segments.flatMap((segment) => [
    <div key={segment.id} style={{ paddingLeft: indent }}>
      {segment.label} {segment.tokens.toLocaleString("en-US")}
    </div>,
    ...(segment.children ? rows(segment.children, indent + 12) : []),
  ]);
}

export default function ContextPage() {
  const navigate = useNavigate();
  const snapshot = useAppSelector((state) => state.session.contextSnapshot);
  const history = useAppSelector((state) => state.session.history);
  const usage = [...history]
    .reverse()
    .find((item) => item.promptLogs?.length)
    ?.promptLogs?.at(-1)?.usage;

  return (
    <div>
      <PageHeader title="Context" onTitleClick={() => navigate(ROUTES.HOME)} />
      <div className="px-4 py-2 text-sm">
        {!snapshot ? (
          <p>Measured when you send the next message</p>
        ) : (
          <>
            <p>
              {`${snapshot.used.toLocaleString("en-US")} of ${snapshot.window.toLocaleString("en-US")} estimated. Pruning starts at ${snapshot.threshold.tokens.toLocaleString("en-US")}.`}
            </p>
            {rows(snapshot.segments)}
            <p className="mt-3 font-bold">Largest tool results</p>
            {snapshot.largestToolResults.map((result) => (
              <div key={`${result.label}-${result.tokens}`}>
                {result.label} {result.tokens.toLocaleString("en-US")}
              </div>
            ))}
            <p className="mt-3 font-bold">Threshold</p>
            {snapshot.threshold.steps.map((step) => (
              <div key={step.label}>
                {step.label} {step.tokens.toLocaleString("en-US")}
              </div>
            ))}
            {usage && (
              <p className="mt-3">
                {`Prompt ${usage.promptTokens.toLocaleString("en-US")} · output ${usage.completionTokens.toLocaleString("en-US")}`}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

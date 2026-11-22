import { Text } from "ink";
import React from "react";

import { formatContextLength } from "../../util/modelSettings.js";
import type { ContextUsage } from "../hooks/useContextPercentage.js";

interface ContextPercentageDisplayProps {
  usage: ContextUsage;
}

export const ContextPercentageDisplay: React.FC<
  ContextPercentageDisplayProps
> = ({ usage }) => {
  return (
    <Text color={usage.nearThreshold ? "yellow" : "dim"}>
      Context {usage.percentage}% · {formatContextLength(usage.used)}/
      {formatContextLength(usage.window)}
    </Text>
  );
};

import { Box, Text } from "ink";
import React from "react";

interface ModelCapabilityWarningProps {
  modelName: string;
}

const ModelCapabilityWarning: React.FC<ModelCapabilityWarningProps> = ({
  modelName,
}) => {
  return (
    <Box flexDirection="column" paddingX={0}>
      <Box flexDirection="row" alignItems="center">
        <Text bold color="white">
          {/* spaces in brackets to prevent prettier from fixing to 1 space */}
          ⚠️{"  "}Model Capability Warning
        </Text>
      </Box>
      <Text color="gray">
        The model "{modelName}" is not recommended for use with cn due to
        limited reasoning and tool calling capabilities
      </Text>
      <Text color="gray">
        If this model supports tool calling, add "capabilities: [tool_use]" to
        it in your config to hide this warning.
      </Text>
    </Box>
  );
};

export { ModelCapabilityWarning };

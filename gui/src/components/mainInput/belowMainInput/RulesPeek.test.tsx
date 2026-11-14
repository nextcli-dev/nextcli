import { act, screen } from "@testing-library/react";
import { RuleMetadata } from "core";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "../../../util/test/render";
import { RulesPeek } from "./RulesPeek";

describe("RulesPeek", () => {
  it("shows nothing when no rules applied", async () => {
    await renderWithProviders(<RulesPeek appliedRules={[]} />);
    expect(screen.queryByTestId("rules-peek")).not.toBeInTheDocument();
  });

  it("counts the applied rules and lists each with where it comes from", async () => {
    const rules: RuleMetadata[] = [
      // As config.json's systemMessage arrives: no name, always applied
      { source: "json-systemMessage", alwaysApply: true },
      {
        name: "TypeScript style",
        source: "rules-block",
        globs: ["**/*.ts", "**/*.tsx"],
      },
    ];
    await renderWithProviders(<RulesPeek appliedRules={rules} />);

    const peek = screen.getByTestId("rules-peek");
    expect(peek).toHaveTextContent("2 rules");

    await act(async () => {
      screen.getByText("2 rules").click();
    });
    const [systemMessage, styleRule] = screen.getAllByTestId("rules-peek-item");
    expect(systemMessage).toHaveTextContent("Agent rule");
    expect(systemMessage).toHaveTextContent("Always applied");
    expect(systemMessage).toHaveTextContent("Source: System Message (JSON)");
    expect(styleRule).toHaveTextContent("TypeScript style");
    expect(styleRule).toHaveTextContent("Pattern: **/*.ts, **/*.tsx");
  });

  it("says rule, not rules, for one", async () => {
    await renderWithProviders(
      <RulesPeek appliedRules={[{ source: "default-agent" }]} />,
    );
    expect(screen.getByTestId("rules-peek")).toHaveTextContent("1 rule");
    expect(screen.getByTestId("rules-peek")).not.toHaveTextContent("1 rules");
  });
});

import { beforeEach, describe, expect, it, Mock, vi } from "vitest";
import { applyForEditTool } from "../../redux/thunks/handleApplyStateUpdate";
import { ClientToolExtras } from "./callClientTool";
import { editToolImpl } from "./editImpl";

vi.mock("uuid", () => ({
  v4: vi.fn(() => "test-uuid"),
}));

vi.mock("../../redux/thunks/handleApplyStateUpdate", () => ({
  applyForEditTool: vi.fn(),
}));

const WORKSPACE = "file:///c%3A/My%20Projects/demo";
const FILE = `${WORKSPACE}/src/index.js`;

describe("editToolImpl", () => {
  let mockExtras: ClientToolExtras;
  let mockApplyForEditTool: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApplyForEditTool = vi.mocked(applyForEditTool);
    mockExtras = {
      getState: vi.fn() as any,
      dispatch: vi.fn() as any,
      ideMessenger: {
        ide: {
          getWorkspaceDirs: vi.fn().mockResolvedValue([WORKSPACE]),
          fileExists: vi.fn(async (uri: string) => uri === FILE),
          getOpenFiles: vi.fn().mockResolvedValue([]),
        },
        request: vi.fn(),
      } as any,
    };
  });

  it.each([
    "src/index.js",
    "src\\index.js",
    "C:\\My Projects\\demo\\src\\index.js",
    "file:///C:/My%20Projects/demo/src/index.js",
  ])("applies the edit to the workspace file for %s", async (filepath) => {
    await editToolImpl(
      { filepath, changes: "// new" },
      "tool-call-id",
      mockExtras,
    );

    expect(mockApplyForEditTool).toHaveBeenCalledWith({
      streamId: "test-uuid",
      text: "// new",
      toolCallId: "tool-call-id",
      filepath: FILE,
    });
  });

  it("rejects a file outside the workspace that is not open", async () => {
    await expect(
      editToolImpl(
        { filepath: "C:\\other\\index.js", changes: "// new" },
        "tool-call-id",
        mockExtras,
      ),
    ).rejects.toThrow(
      "C:\\other\\index.js does not exist in the workspace or the open editors",
    );
    expect(mockApplyForEditTool).not.toHaveBeenCalled();
  });
});

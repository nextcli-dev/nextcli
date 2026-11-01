import { describe, expect, it } from "vitest";

import { BackgroundJobService } from "./BackgroundJobService.js";

describe("BackgroundJobService output limits", () => {
  // #12700: the line cap alone does not bound a few huge lines
  it("caps output that is one huge line", () => {
    const service = new BackgroundJobService();
    const job = service.createJob("noisy")!;

    service.appendOutput(job.id, "x".repeat(500_000));

    expect(service.getJob(job.id)!.output.length).toBe(100_000);
  });

  it("keeps the newest output", () => {
    const service = new BackgroundJobService();
    const job = service.createJob("noisy")!;

    service.appendOutput(job.id, "old".repeat(50_000));
    service.appendOutput(job.id, "NEWEST");

    expect(service.getJob(job.id)!.output.endsWith("NEWEST")).toBe(true);
  });
});

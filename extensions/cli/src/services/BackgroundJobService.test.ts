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

// #12699: cancelling a job must kill the processes the job's shell started
describe.skipIf(process.platform === "win32")(
  "BackgroundJobService process cleanup",
  () => {
    const isAlive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const waitFor = async (condition: () => boolean) => {
      for (let i = 0; i < 50 && !condition(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return condition();
    };

    it.each(["cancelJob", "killAllJobs"] as const)(
      "%s kills grandchildren",
      async (method) => {
        const service = new BackgroundJobService();
        const job = service.createJob("sleep")!;
        service.startJob(job.id, "/bin/sh", ["-c", "sleep 30 & echo $!; wait"]);

        expect(await waitFor(() => /\d+/.test(job.output))).toBe(true);
        const grandchildPid = Number(job.output.trim());
        expect(isAlive(grandchildPid)).toBe(true);

        if (method === "cancelJob") {
          service.cancelJob(job.id);
        } else {
          service.killAllJobs();
        }

        expect(await waitFor(() => !isAlive(grandchildPid))).toBe(true);
      },
    );
  },
);

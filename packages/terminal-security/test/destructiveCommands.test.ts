import { describe, expect, it } from "vitest";
import { evaluateTerminalCommandSecurity } from "../src/index.js";

// Regression tests for continuedev/continue#13001: destructive commands must
// be "disabled", because headless and auto mode run anything else unprompted.
const evaluate = (command: string) =>
  evaluateTerminalCommandSecurity("allowedWithoutPermission", command);

describe("destructive command blocklist (#13001)", () => {
  describe("recursive rm flags in any case or order", () => {
    it.each([
      "rm -Rf /",
      "rm -fR /",
      "rm -R -f /",
      "rm -r /",
      "rm --recursive --force /",
      "rm -rf -- /",
      "/bin/rm -Rf /",
      "RM -RF /",
    ])("disables %s", (command) => {
      expect(evaluate(command)).toBe("disabled");
    });
  });

  describe("dangerous deletion targets", () => {
    it.each([
      "rm -rf ~",
      "rm -rf ~/",
      "rm -rf ~/*",
      "rm -rf $HOME",
      "rm -rf ${HOME}",
      'rm -rf "$HOME/"',
      "rm -rf $PROJECT_ROOT",
      "rm -rf /home",
      "rm -rf /home/alice",
      "rm -rf /root",
      "rm -rf /var",
      "rm -rf /opt/",
      "rm -rf /Users",
      "rm -rf /Users/alice/",
      "rm -rf /Library",
      "rm -rf /System/Library",
      "rm -rf /boot/grub",
      "rm -rf /lib64/x",
    ])("disables %s", (command) => {
      expect(evaluate(command)).toBe("disabled");
    });

    it.each([
      "rm -rf ./build",
      "rm -rf node_modules dist",
      "rm -rf /tmp/scratch/output",
      "rm -rf $HOME/project/build",
      "rm -rf /Users/alice/project/build",
    ])("does not disable %s", (command) => {
      expect(evaluate(command)).not.toBe("disabled");
    });
  });

  describe("wrapped and chained deletes", () => {
    it.each([
      "xargs rm -Rf /",
      "env FOO=1 rm -Rf /",
      "nohup rm -R -f /var &",
      "cd /tmp && rm -Rf ~",
      "echo done; rm -Rf $HOME",
      "$CMD -Rf /",
    ])("disables %s", (command) => {
      expect(evaluate(command)).toBe("disabled");
    });
  });

  describe("Windows deletes", () => {
    it.each([
      "rmdir /s /q C:\\",
      "rd /s /q C:\\Windows",
      "Remove-Item -Recurse -Force C:\\",
      "Remove-Item -Recurse -Force C:/Users",
    ])("disables %s", (command) => {
      expect(evaluate(command)).toBe("disabled");
    });

    it("does not treat /s and /q switches as paths", () => {
      expect(evaluate("rmdir /s /q build")).not.toBe("disabled");
    });
  });

  describe("find deletes", () => {
    it.each([
      "find / -delete",
      "find ~ -type f -delete",
      "find / -exec rm -rf {} +",
      "find $HOME -execdir rm {} ;",
    ])("disables %s", (command) => {
      expect(evaluate(command)).toBe("disabled");
    });

    it.each([
      "find /tmp -name '*.tmp' -delete",
      "find . -type f -delete",
      "find ~ -name '*.pyc' -delete",
    ])("still asks for %s", (command) => {
      expect(evaluate(command)).toBe("allowedWithPermission");
    });
  });

  describe("disk and system file wipes", () => {
    it.each([
      "wipefs -a /dev/sda",
      "shred -u /dev/sda",
      "shred -u /etc/passwd",
      "truncate -s 0 /etc/passwd",
      "truncate --size=0 /etc/shadow",
      "fdisk /dev/sda",
      "parted /dev/sda mklabel gpt",
      "sgdisk --zap-all /dev/sda",
      "diskutil eraseDisk APFS Empty disk2",
      "diskutil zeroDisk disk2",
      "diskutil apfs deleteContainer disk3",
      "pkexec bash",
    ])("disables %s", (command) => {
      expect(evaluate(command)).toBe("disabled");
    });

    it.each([
      "truncate -s 0 app.log",
      "shred -u secrets.txt",
      "fdisk -l",
      "diskutil list",
    ])("does not disable %s", (command) => {
      expect(evaluate(command)).not.toBe("disabled");
    });
  });
});

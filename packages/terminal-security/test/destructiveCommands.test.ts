import { describe, expect, it } from "vitest";

import {
  evaluateTerminalCommandSecurity,
  isDestructiveTerminalCommand,
} from "../src/index.js";

// Regression tests for continuedev/continue#13001 and the PR #7 review.
// Headless and auto mode run anything that isn't "disabled", unless the CLI
// sees isDestructiveTerminalCommand() and asks a person instead. So:
// - catastrophic: disabled, never runs;
// - destructive: not disabled, but needs a person;
// - none: neither.
type Tier = "catastrophic" | "destructive" | "none";

function tier(command: string): Tier {
  if (
    evaluateTerminalCommandSecurity("allowedWithoutPermission", command) ===
    "disabled"
  ) {
    return "catastrophic";
  }
  return isDestructiveTerminalCommand(command) ? "destructive" : "none";
}

function expectTier(commands: string[], expected: Tier) {
  it.each(commands)(`%s is ${expected}`, (command) => {
    expect(tier(command)).toBe(expected);
  });
}

describe("destructive command tiers (#13001)", () => {
  describe("recursive rm flags in any case or order", () => {
    expectTier(
      [
        "rm -Rf /",
        "rm -fR /",
        "rm -R -f /",
        "rm -r /",
        "rm --recursive --force /",
        "rm -rf -- /",
        "/bin/rm -Rf /",
        "RM -RF /",
      ],
      "catastrophic",
    );
  });

  describe("paths that resolve to a root, home or system directory", () => {
    expectTier(
      [
        "rm -rf ~",
        "rm -rf ~/",
        "rm -rf ~/*",
        "rm -rf ~/..",
        "rm -rf $HOME",
        "rm -rf ${HOME}",
        'rm -rf "$HOME/"',
        "rm -rf ${HOME:-/}",
        "rm -rf ${UNSET_VAR:-/}",
        "rm -rf /tmp/../etc",
        "rm -rf /private/tmp/../../Users",
        "rm -rf /System/Volumes/Data/Users/alice",
        "rm -rf /home",
        "rm -rf /home/alice",
        "rm -rf /Users/alice/",
        "rm -rf /root",
        "rm -rf /System/Library",
        "rm -rf /boot/grub",
        "rm -rf /lib64/x",
        "rm -rf ~alice",
      ],
      "catastrophic",
    );
  });

  describe("broad deletes that need a person", () => {
    expectTier(
      [
        "rm -rf /tmp",
        "rm -rf /private/tmp",
        "rm -rf /tmp/*",
        "rm -rf /var",
        "rm -rf /opt/",
        "rm -rf /Library",
        "rm -rf $PROJECT_ROOT",
        "rm -rf ${BUILD_DIR}/..",
        "rm -rf ${X#prefix}",
        "rm -rf ~/Documents",
        "rm -rf /Users/alice/Documents",
        "rm -rf .",
        "rm -rf ../..",
        "rm -rf `echo /`",
        "rm -rf $(pwd)",
        "ln -s / /tmp/x && rm -rf /tmp/x/",
        "ln -sf $HOME ./home-link",
      ],
      "destructive",
    );
  });

  describe("ordinary cleanup", () => {
    expectTier(
      [
        "rm -rf ./build",
        "rm -rf node_modules dist",
        "rm -rf /tmp/scratch/output",
        "rm -rf /private/tmp/scratch/output",
        "rm -rf $HOME/project/build",
        "rm -rf ${OUT_DIR}/build",
        "rm -rf /Users/alice/project/build",
        "rm -rf /var/folders/ab/cd/T/build",
        "rm build.log",
        "ln -s /usr/bin/python3 ./python",
      ],
      "none",
    );
  });

  describe("wrappers, shells and chains", () => {
    expectTier(
      [
        "xargs rm -Rf /",
        "env FOO=1 rm -Rf /",
        "FOO=1 rm -rf /",
        "nohup rm -R -f /usr &",
        "timeout 10 rm -rf ~",
        "nice -n 5 rm -rf /etc",
        "busybox rm -rf /",
        "cd /tmp && rm -Rf ~",
        "echo done; rm -Rf $HOME",
        "echo a\nrm -rf /",
        "$CMD -Rf /",
        "bash -c 'rm -rf /'",
        "sh -c 'rm -rf $HOME'",
        "bash -lc 'rm -rf ~'",
        "sh -c \"bash -c 'rm -rf /'\"",
        "pwsh -Command Remove-Item -Recurse -Force C:\\",
      ],
      "catastrophic",
    );

    expectTier(
      [
        "echo / | xargs rm -rf",
        "echo / | xargs -I {} rm -rf {}",
        "find . -name x | xargs -0 rm -rf",
        "bash -c 'rm -rf /tmp'",
        // cd isn't followed, and `usr/..` is the working directory
        "zsh -c 'cd / && rm -rf usr/..'",
        "powershell -EncodedCommand ZQBjAGgAbwA=",
      ],
      "destructive",
    );

    expectTier(["bash -c 'rm -rf ./build'", "xargs echo"], "none");
  });

  describe("Windows deletes", () => {
    expectTier(
      [
        "rmdir /s /q C:\\",
        "rd /s /q C:\\Windows",
        "Remove-Item -Recurse -Force C:\\",
        "Remove-Item -Recurse -Force C:/Users",
        "Remove-Item -Recurse -Force C:\\Users\\alice",
        "Remove-Item -Recurse -Force C:\\Windows\\System32",
        'Remove-Item -Recurse -Force "C:\\Program Files\\App"',
        "Remove-Item -Recurse -Force $env:USERPROFILE",
        "Remove-Item -Recurse -Force %USERPROFILE%",
        "Remove-Item -Rec -Force C:\\Users\\alice\\..",
        "rm -r -fo C:\\ProgramData",
      ],
      "catastrophic",
    );

    expectTier(
      [
        "Remove-Item -Recurse -Force C:\\Temp",
        "Remove-Item -Recurse -Force C:\\Users\\alice\\Documents",
        "Remove-Item -Recurse -Force $env:TEMP",
      ],
      "destructive",
    );

    expectTier(
      [
        "rmdir /s /q build",
        "Remove-Item -Recurse -Force .\\build",
        "Remove-Item -Recurse -Force C:\\Users\\alice\\project\\build",
        "Remove-Item -Recurse -Force $env:TEMP\\nextcli",
      ],
      "none",
    );
  });

  describe("find deletes", () => {
    expectTier(
      [
        "find / -delete",
        "find ~ -type f -delete",
        "find / -exec rm -rf {} +",
        "find $HOME -execdir rm {} ;",
        "find / -delete -name keep.txt",
        "find / -name '*' -delete",
        "find / -name x -o -delete",
        "find / ! -name x -delete",
        "find / -regex '.*' -delete",
      ],
      "catastrophic",
    );

    expectTier(["find . -type f -delete", "find /tmp -delete"], "destructive");

    expectTier(
      [
        "find /tmp -name '*.tmp' -delete",
        "find . -name '*.pyc' -delete",
        "find ~ -name '*.pyc' -delete",
        "find / -name x",
        "find . -type f -exec grep foo {} +",
      ],
      "none",
    );
  });

  describe("disk and system file wipes", () => {
    expectTier(
      [
        "wipefs -a /dev/sda",
        "wipefs -af /dev/sda",
        "wipefs --all /dev/sda",
        "shred -u /dev/sda",
        "shred -u /etc/passwd",
        "truncate -s 0 /etc/passwd",
        "truncate -s 0B /etc/passwd",
        "truncate -s0K /etc/passwd",
        "truncate --size=0 /etc/shadow",
        "truncate -s -100 /etc/hosts",
        "fdisk /dev/sda",
        "parted /dev/sda mklabel gpt",
        "parted /dev/sda mklabel gpt print",
        "sgdisk --zap-all /dev/sda",
        "sgdisk --zap-all --print /dev/sda",
        "fdisk -l /dev/sda --wipe always",
        "diskutil eraseDisk APFS Empty disk2",
        "diskutil zeroDisk disk2",
        "diskutil apfs deleteContainer disk3",
        "pkexec bash",
      ],
      "catastrophic",
    );

    expectTier(
      [
        "wipefs /dev/sda",
        "wipefs -n /dev/sda",
        "wipefs -a -n /dev/sda",
        "truncate -s 0 app.log",
        "truncate -s 10M /etc/hosts.bak2",
        "shred -u secrets.txt",
        "fdisk -l",
        "fdisk -l /dev/sda",
        "parted -l",
        "parted /dev/sda print",
        "sgdisk -p /dev/sda",
        "diskutil list",
      ],
      "none",
    );
  });
});

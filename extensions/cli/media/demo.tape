# Records media/demo.gif for the CLI README.
#
# Requires: vhs (https://github.com/charmbracelet/vhs), npm, and a working model
# in ~/.continue/config.yaml. Records the latest published @nextcli/cli.
#
# Run from extensions/cli:
#   vhs media/demo.tape

Output media/demo.gif

Require npm

Set Shell bash
Set FontSize 18
Set Width 1200
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Set WindowBar Colorful

# Sample project and a clean global dir (only config.yaml and the .env it reads
# secrets from; no personal rules or history) so the recording doesn't depend
# on the local machine. The temp dir is removed at the end.
Hide
Type `export DEMO_ROOT="$(mktemp -d)" && export CONTINUE_GLOBAL_DIR="$DEMO_ROOT/global" && mkdir -p "$CONTINUE_GLOBAL_DIR" && cp ~/.continue/config.yaml "$CONTINUE_GLOBAL_DIR/" && { cp ~/.continue/.env "$CONTINUE_GLOBAL_DIR/" 2>/dev/null || true; }` Enter
Type `npm install --silent --prefix "$DEMO_ROOT/npm" @nextcli/cli@latest && export PATH="$DEMO_ROOT/npm/node_modules/.bin:$PATH"` Enter
Wait@120s
Type `mkdir -p "$DEMO_ROOT/todo-app/src" && cd "$DEMO_ROOT/todo-app"` Enter
Type `printf '{\n  "name": "todo-app",\n  "version": "1.0.0",\n  "type": "module"\n}\n' > package.json` Enter
Type `printf 'export function addTodo(todos, title) {\n  return [...todos, { title, done: false }];\n}\n\nexport function toggleTodo(todos, index) {\n  return todos.map((t, i) => (i === index ? { ...t, done: !t.done } : t));\n}\n' > src/todos.js` Enter
Type `export PS1="\[\e[1;35m\]todo-app\[\e[0m\] $ " && clear` Enter
Sleep 500ms
Show

Type "cn"
Sleep 400ms
Enter
Sleep 5s

Type "What does src/todos.js do? Answer in two sentences."
Sleep 600ms
Enter
Sleep 14s

Ctrl+C
Sleep 300ms
Ctrl+C
Sleep 1s

Hide
Type `cd / && rm -rf "$DEMO_ROOT"` Enter

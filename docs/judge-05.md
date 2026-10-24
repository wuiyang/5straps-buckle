# The decision AI: why it rates nothing

When the [decision AI](judge.md), the optional model check Buckle (the approval and sandbox
runtime on this machine) runs with the node's own keys, does not rate a call, and the reason it
gives. Its stages are Jev (TypeSafe AI's quick decision model) and the thorough model behind an
OpenAI-compatible endpoint. [What it reads](judge-02.md) and [what it keeps and
shows](judge-03.md) come before this page.

## What no stage is shown

No stage is asked where Buckle cannot show the code that runs, and the ask then goes to a person.
An allowed command Jev screens under `approval.quickJudge all` is rated on its command line alone,
whatever the reader could not read, so no word the agent adds switches the screen off; its audit
entry names the reason as `codeUnread`. Not shown:

- shell text that is not one simple command;
- a variable that changes what code runs, such as `PATH`, `NODE_OPTIONS`, `PYTHONPATH`, `SHELL`,
  `HOME`, `ARGV0`, or npm's `npm_config_node_options` (the audit entry names it, never its value),
  and npm's own `--node-options`, `--script-shell`, `--userconfig`, and `--globalconfig`, by any
  prefix npm takes (`--node-opt=`);
- a change of working directory (`cd`, `chdir`, `pushd`, `env -C`, `sudo -D`, or `--cwd`), or a
  word selecting another workspace package (npm `-w`, bun `--filter`), each also as npm reads an
  option (`--prefi=sub`, `--C sub`, `--w a`);
- a program named by a path inside the workspace or a mount, an interpreter, wrapper, shell, or
  runner alike: by any relative path holding a separator, by an absolute path holding a backslash,
  a `.` or `..` segment, or a place under `/proc` or `/dev/fd`, or by a command word that reads as
  an assignment (`FOO=fv/x`);
- a name whose `..` follows a link, which the kernel resolves from where the link points, not as
  text (node, which resolves its own names as text, is read as before);
- an interpreter behind `xargs`;
- a runner package named by anything but a registry name and version (`npx ./tool`,
  `npx eslint@.`), or by a scope or name that is not URL-safe (`npx @scope/x#y`);
- an option, subcommand, `python3 -m` module (`runpy`, `pydoc`, and other runners, or a second
  `-m`), interactive flag, import, or config file the reader does not model;
- compiled Python beside a module it would show, or in a folder it cannot list;
- code on an input nothing feeds (`python3 -`), and code past 50 files or 512 KiB;
- a script, import, or argument it cannot find, may not read, or finds is not text.

[Known limits, part six](known-limits-06.md) lists each.

## The reasons

An `unavailable` reason says why no stage rated a command. Besides a variable that changes what
code runs, a change of working directory, code past the caps, and a file it cannot find or read,
the reader's reasons include: "shell text the reader does not rate whole", "an option the reader
does not know", "a subcommand the reader does not model", "an interactive flag reads standard input
as code", "a module that discovers or evaluates code the reader does not show", "the code the
interpreter runs comes from standard input the reader cannot place", "an import the reader does not
model", "the code runs compiled Python the reader cannot show", "a config file the reader could not
parse", "the interpreter is a program inside the workspace", "the call sets the program name the
interpreter reads", "the call splits a word into words the reader does not read again", "the runner
runs a package from a path or a source the reader does not show", "the call hands the interpreter
words it reads from a file or puts in place of its own", "a path climbs with .. past a link or a
missing folder, so the program may open another file than the reader would show", "the call sets an
npm option that changes what code runs; the decision AI does not rate it", "the code lies outside
the workspace folder the isolated shell copies, so it could change after the check", and "the
package.json script the standard script names could not be read".

The shell-text reason also covers `flock -c` text, a heredoc a shell reads as its script (`busybox
sh <<EOF`), one fed to another interpreter holding a line that starts with an interpreter's name,
and, inside shell text, a wrapper that sets the program name or splits a word (`exec -a`, `env -a`,
`env -S`) and a quoted or `+=` command word that reads as an assignment. The local-program reason
covers a wrapper, a shell, and a runner named by a path inside the workspace or a mount, any relative
program path holding a separator, an absolute one holding a backslash, a `.` or `..` segment, or a
place under `/proc` or `/dev/fd`, and a command word that reads as an assignment; the runner reason,
a version part naming a folder (`npx eslint@.`) and a scope or name that is not URL-safe; the
working-directory reason, a word selecting another workspace package (npm `-w`, bun `--filter`), by
any spelling npm reads. The interactive reason covers `php -a` after `-f` and `python3 -m pdb`,
`code`, `asyncio`, or `idlelib`; the module reason, `-m unittest`, `pytest`, `timeit`, `runpy`,
`pydoc`, `inspect`, `cProfile`, `profile`, `trace`, `doctest`, `pickle`, and `pickletools`, and a
second `-m`; the unknown-option reason, a `python3 -X` value off the reader's short list
(`pycache_prefix` and `frozen_modules` among them); the import reason, an ES module specifier
holding a control, a tab, or a leading or trailing space; and the compiled-Python reason, a folder
the reader cannot list. A reason is cut to 500 characters, never inside an escape it quotes.

The command rules leave a call unread on their own where a word ends in a parenthesised list
holding an `e`, a `+`, a `$`, or a backtick, which zsh may read as glob qualifiers that run code
(`*(e:'...':)`, or `*($v)`, since zsh fills in an expansion first), in any shell's text: "A zsh
glob qualifier may run shell code: a word ends in a parenthesised list holding an e, a +, a $, or a
backtick, which zsh may read as qualifiers that run code once for each file the pattern matches,
and Buckle does not read that code (glob qualifier)". Such a call is refused under a deny list and
asks at the floor with none.

The limits are on [Known limits, part six](known-limits-06.md) and [part
seven](known-limits-07.md).

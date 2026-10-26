# MessageFormat for Zed

Syntax highlighting, bracket matching and diagnostics for [ICU MessageFormat](https://unicode-org.github.io/icu/userguide/format_parse/messages/) files in [Zed](https://zed.dev). Highlighting is powered by [tree-sitter-messageformat](https://github.com/bearfriend/tree-sitter-messageformat); diagnostics come from a [language server](#language-server) built on [messageformat-validator](https://www.npmjs.com/package/messageformat-validator).

Two languages are included:

| Language | Use | Matches |
| --- | --- | --- |
| **MessageFormat** | Resource files: `key: "message"` entries, optionally wrapped in `export default { ... };` | `.mf` and `.mf.js` |
| **MessageFormat Message** | A single bare message such as `Hello {name}!`, meant for embedding inside other files | Markdown fences ```` ```messageformat-message ````; no file extensions |

## Installing as a dev extension

1. Clone this repository.
2. In Zed, run **zed: install dev extension** and select **this repository's root directory** (the folder containing `extension.toml`).

Rust must be installed via `rustup`; Zed compiles the extension and the grammar for you.

## Language server

Resource files (`.mf` and `.mf.js`) get diagnostics from `messageformat-language-server` (source in [`lsp/`](lsp/)). Zed installs it from npm using its own Node.js, so nothing needs to be set up. The locale for plural rules comes from the file name up to the first dot (`fr-ca.mf.js` is `fr-ca`); a name that isn't a locale (`messages.mf.js`) is treated as `en`.

**Checks on every message**

| Code | Severity | Meaning |
| --- | --- | --- |
| `parse` | error | Syntax error, such as an unterminated `{name` |
| `other` | error | A `select` or `plural` without an `other` option |
| `category` | error | A plural category the locale doesn't have (`few` in English) |
| `category-missing` | warning | A plural category the locale has but the message doesn't |
| `nbsp` | error | A non-breaking space in the message structure |
| `escape` | warning | An unterminated escape run: a `'` before `{`, `}`, `<` (or `#` in a plural) that is never closed, so it quotes the rest of the message. `'>` is an apostrophe, not a run. |
| `duplicate` | error | The same key defined twice |

**Checks against a source locale.** A translation is also compared with its source file, which must sit in the same directory:

1. The nearest `mfv.config.json` at or above the file names the source in `"source"` (the same file [`mfv`](https://www.npmjs.com/package/messageformat-validator) reads). If it has a `"locales"` list, only those locales are compared.
2. With no config, or no `"source"`, the source defaults to `en`, then `en-us`, **only if such a file exists**.
3. If no source file is found, these checks are simply skipped.

| Code | Severity | Meaning |
| --- | --- | --- |
| `extraneous` | error | The key isn't in the source |
| `missing` | warning | Source keys absent from this file, summarised once on the first line |
| `argument` | error | An argument name the source doesn't use |
| `option`, `option-missing` | error | A select/plural option the source doesn't have, or lacks one it has |
| `untranslated` | warning | Identical to the source (regional variants such as `en-gb` are exempt) |

Add `// mfv-translated` after an entry to mark a message as deliberately identical to its source. The source is read from its open editor buffer if it has one, otherwise from disk, and editing it re-checks every translation open beside it.

Changes made outside the editor are noticed too: the server watches the directory of each open file and the directory of its `mfv.config.json`, and re-checks when a `.mf`, `.mf.js` or `.js` file or the config changes there (for example after `git checkout`, or an `mfv`/translation tool rewriting the source). Files open in an editor buffer are never overridden by what is on disk. A config newly created in a parent directory that had none is only picked up when the file is reopened. This uses Node's file watching directly rather than Zed's LSP file-watcher registration, so it doesn't depend on client support, but it has been verified by tests only, not yet by hand in Zed.

**Quick fixes.** Open the code actions menu on a diagnostic (the lightbulb, or `cmd-.` in Zed):

| Code | Fix |
| --- | --- |
| `nbsp` | Replace the non-breaking space with a normal space |
| `untranslated` | Add `mfv-translated` to a comment after the message |
| `escape` | Close the run with a `'` where it should end: before the `}` or closing tag that ends what it is in, otherwise at the end of the message |
| `argument` | Correct argument names using the source message |
| `category` | Rename an unsupported plural category (when exactly one supported category is unused), or remove the unsupported categories |
| `category-missing` | Add the missing plural categories, copying `other`, in the usual order |
| `other` | Add the missing `other` to a plural or a select, copying the last case |
| `option-missing` | Add the select options the source message has, copying `other` |
| `extraneous` | Remove the whole entry (its lines, comma and comment) |
| `duplicate` | Remove the later definition; the first one is kept |
| `missing` | Copy the missing messages from the source, each after the entry that precedes it in the source |

The `argument`, `category`, `category-missing`, `other` and `option-missing` fixes are done by `mfv`'s formatter, limited to the one change. Each is checked before it is offered: the fix has to make its diagnostic go away without introducing a new error, so some fixes are deliberately all-or-nothing. If only some argument names can be matched to the source, or the right name is ambiguous, nothing is offered. For the same reason, a select with a misspelt argument name doesn't get `other` or `option-missing` fixes until the `argument` fix has been applied. Spacing inside the message's braces is normalised.

The formatter's `add` is what adds cases, and it adds both plural categories and select options. So adding a missing option to a message that also has a plural short of categories adds those categories too.

There is also a **Format message with mfv** action (kind `refactor.rewrite`) for any entry under the cursor, with or without a diagnostic. It does what `mfv format` does by default: hoists selectors, sorts plural cases, and curls apostrophes. It never renames arguments.

The `extraneous`, `duplicate` and `missing` fixes edit whole entries rather than going through the formatter. Removing an entry deletes its lines, so nothing is offered if another entry or code shares the line. `missing` copies the source's key and message as it wrote them (quotes and escapes included, its comment left out), indented like the file's first entry, and adds the comma to the entry it follows if that lacks one. The copies are identical to the source, so they show up as `untranslated` warnings until translated, which makes a handy to-do list.

The server computes fixes from the document itself, not from the diagnostics the client sends back. Invoking an action with `cmd-.` works in Zed, though the lightbulb does not always show up.

Diagnostics only appear in files Zed treats as **MessageFormat**. Zed can't attach a language server to MessageFormat strings embedded in other languages (see below).

### Settings

Options go under `initialization_options` in your Zed `settings.json`. Changing them restarts the server.

```json
"lsp": {
  "messageformat-language-server": {
    "initialization_options": {
      "compareToSource": false,
      "defaultLocale": "en"
    }
  }
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `compareToSource` | `true` | Set to `false` to turn off every check against a source locale (`extraneous`, `missing`, `argument`, `option`, `option-missing`, `untranslated`). Only a literal `false` disables it. The checks on every message still run. |
| `defaultLocale` | `en` | Locale for plural rules when the file name isn't a locale (`messages.mf.js`). |

### Running a local copy of the server

Point Zed at a checkout instead of the published package (for example while developing it) in your `settings.json`:

```json
"lsp": {
  "messageformat-language-server": {
    "binary": {
      "path": "/path/to/node",
      "arguments": ["/path/to/messageformat-zed/lsp/server.js", "--stdio"],
      "env": { "MESSAGEFORMAT_LS_LOG": "/tmp/mfls.log" }
    }
  }
}
```

`MESSAGEFORMAT_LS_LOG` is optional: it appends a trace of opened and validated files, and crashes, to that file. Zed also shows the server's output under **dev: open language server logs**.

> **Restart Zed after changing the extension or server.** In testing, **zed: rebuild dev extension** left Zed's language-server startup hanging (the server was spawned but never sent `initialize`) until Zed was quit and reopened. This is an inference from Zed's logs, not something confirmed upstream.

## How the grammar gets here

```
tree-sitter-messageformat (grammar repo)             messageformat-zed (this repo)
  grammar.js, src/parser.c      ── pinned by ───▶    extension.toml  [grammars.messageformat]
  message/grammar.js,                                  repository = "https://github.com/.../tree-sitter-messageformat"
  message/src/parser.c          ── pinned by ───▶      rev        = "<full commit SHA>"
                                                     extension.toml  [grammars.messageformat_message]
                                                       (same repository and rev, path = "message")
  queries/{highlights,brackets}.scm
                                ── copied by ───▶    languages/messageformat/
  message/queries/{highlights,brackets}.scm
                                ── copied by ───▶    languages/messageformat_message/
```

- **The parsers** are not stored here. Zed clones `repository` into `grammars/<name>/`, checks out `rev` and compiles `src/parser.c` (under `path`, if set) to wasm. Both grammars come from the same repository and are pinned to the same commit.
- **The queries are copies.** Zed does not read queries from the grammar repo, so the `.scm` files under `languages/` must match the grammar repo at the pinned `rev`. Never edit them here; change them in the grammar repo and sync.
- Each `languages/*/config.toml` is owned by this repo.
- The second grammar's key must be `messageformat_message` (snake case): Zed looks up the wasm export `tree_sitter_messageformat_message`.

## Embedding in other languages (JS, HTML, Java, Kotlin, Swift, ...)

This extension registers the **MessageFormat Message** language so that hosts *can* inject it, but **a Zed extension cannot add injections to a built-in language** ([zed#8795](https://github.com/zed-industries/zed/issues/8795), [zed#65382](https://github.com/zed-industries/zed/issues/65382)). Zed reads injections only from the host language's own `injections.scm`. So today:

- `.mf` / `.mf.js` files are highlighted as resource files.
- Markdown fences tagged `messageformat-message` use the bare-message language (and plain `messageformat` fences use the resource-file language). *Resolution logic is from Zed's source; I haven't confirmed the rendering in Zed itself.*
- MessageFormat strings inside `.js`, `.html`, `.java`, ... are **not** highlighted yet. That needs the host's `injections.scm` to change in Zed itself.

The language answers to the names `messageformat-message` and `messageformat_message` (Zed resolves injection and fence names by language name or path suffix), so an upstream injection written as `(#set! injection.language "messageformat_message")` will resolve to it. Zed leaves an injection of a language that isn't installed pending, and re-parses once it appears, so such upstream rules would be inert for users without this extension.

The ready-to-use host queries (JavaScript/TypeScript/TSX, JSON, HTML, Java, Kotlin, Swift) live in the [grammar repo](https://github.com/bearfriend/tree-sitter-messageformat#embedding-in-other-languages) for Neovim, Helix and other tree-sitter tools, and as the basis for proposing them to Zed.

## Updating the grammar

1. Make and test your grammar changes in the grammar repo, commit, and **push** (Zed can only fetch pushed commits).
2. Here, run:

   ```bash
   scripts/sync-grammar.sh            # copy queries from the grammar's default branch, pin rev to its HEAD
   scripts/sync-grammar.sh <ref>      # ...or from a specific branch/tag/SHA
   cargo test
   ```

3. Commit `extension.toml` and `languages/*/*.scm` together.
4. In Zed run **zed: rebuild dev extension** and open `test/sample.mf`.

`scripts/sync-grammar.sh --check` verifies that the shipped queries equal the queries at each grammar's pinned `rev`; CI runs it on every push. Set `GRAMMAR_REPO=/path/to/local/checkout` to sync from a local clone (only committed content is used).

If you ever change the grammar `repository` URL, delete `grammars/` so Zed re-clones from the new origin.

## Development

```bash
cargo test                          # manifest, config and query consistency checks
cargo check --target wasm32-wasip1  # the extension itself builds as wasm
cd lsp && npm ci && npm test        # language server (Node 20 or newer)
```

When `../tree-sitter-messageformat` is checked out next to this repo, the tests additionally verify that the queries only use node types that exist in each grammar, that they match the sibling's queries, and that every `injection.language` the grammar repo's host queries emit resolves to the message language.

Manual test files:
- `test/sample.mf` &mdash; open in Zed to check highlighting by eye
- `test/manual/messages.mf.js` &mdash; larger sample in module form
- `test/manual/lang/fr-ca.mf.js` and `en.mf.js` &mdash; a translation with one example of every diagnostic, and its source; comments beside each entry say what to expect
- `test/injection-test.mf.js` &mdash; JS sample of MessageFormat inside another language. Zed can't inject it yet (see above); the automated injection tests are in the grammar repo (`test/host-injections/`)

Zed's log is at `~/Library/Logs/Zed/Zed.log` (macOS) if the extension fails to install.

## Publishing

The language server is published to npm as [`messageformat-language-server`](https://www.npmjs.com/package/messageformat-language-server) from `lsp/` (`cd lsp && npm test && npm publish`). The extension installs the latest version at runtime, so publish the server **before** releasing an extension version that depends on new server behaviour.

The extension itself goes through the [zed-industries/extensions](https://github.com/zed-industries/extensions) registry; see Zed's [extension docs](https://zed.dev/docs/extensions/developing-extensions) for the current requirements. Before submitting, make sure both repositories are pushed publicly, `extension.toml` `rev` is a pushed commit, and `scripts/sync-grammar.sh --check` passes.

## License

MIT &copy; 2026 Danny Gleckler. See [LICENSE](LICENSE).

# messageformat-language-server

A language server (LSP over stdio) that validates MessageFormat resource files such as `.mf` and `.mf.js`. It wraps [`messageformat-validator`](https://www.npmjs.com/package/messageformat-validator) and the [`@formatjs/icu-messageformat-parser`](https://www.npmjs.com/package/@formatjs/icu-messageformat-parser) syntax parser.

It is used by the [MessageFormat extension for Zed](https://github.com/bearfriend/messageformat-zed), which installs it automatically, but it works with any editor that can launch a stdio language server:

```sh
npm install -g messageformat-language-server
messageformat-language-server --stdio
```

Requires Node.js 20 or later.

## Diagnostics

Syntax errors, missing `other` options, invalid or missing plural categories for the file's locale, non-breaking spaces, unterminated escape runs, and duplicate keys. When a source locale file sits beside the file (named by `"source"` in the nearest `mfv.config.json`, or `en` / `en-us` if present), translations are also checked for extraneous or missing keys, mismatched arguments and options, and untranslated messages.

See the [full list of checks](https://github.com/bearfriend/messageformat-zed#language-server).

## Logging

Set `MESSAGEFORMAT_LS_LOG=/path/to/file` to append a trace of opened and validated files to a file.

## License

MIT

; Comments
(comment) @comment

; Keys in resources
(key (identifier) @property)
(key (quoted_string) @property)

; String literals (keys are captured separately as @property)
(value (quoted_string) @string)
(value (template_string) @string)
(plural_case_body (quoted_string) @string)
(plural_case_body (template_string) @string)
(select_case_body (quoted_string) @string)
(select_case_body (template_string) @string)

; Variables -- scoped by parent so patterns never overlap with
; keys (@property), select keys (@constant) or tags (@tag)
(placeholder (identifier) @variable)
(complex_message (identifier) @variable)
(selector (identifier) @variable)

; Message format keywords
[(plural) (select) (selectordinal)] @keyword
"offset:" @keyword

; Module wrapper (.mf.js: `export { ... }`, `export default { ... }`,
; `export const|let name = { ... }`; .mf.json: a bare `{ ... }`)
["export" "default" "const" "let"] @keyword
(module_start (identifier) @variable)
(module_end ";" @punctuation.delimiter)

; Format types
["number" "date" "time"] @type

; Plural case keywords
(plural_key ["zero" "one" "two" "few" "many" "other"]) @constant.builtin

; Select keys (`other` is the required fallback, like in plural)
(select_key (identifier) @constant)
(select_key "other" @constant.builtin)

; Numbers
(number) @number

; Style formats
(style_format) @constant.builtin

; Skeleton format
(skeleton_format "::" @operator)
(skeleton_pattern) @string.special

; Pound placeholder
(pound_placeholder) @variable.special

; Tags
(tag (identifier) @tag)

; Escaped characters (`'{'`, `''`, ...)
(escaped_char) @string.escape

; Operators and punctuation
["=" "/"] @operator
["," ":"] @punctuation.delimiter
["{" "}" "<" ">"] @punctuation.bracket

; Note: string quotes are deliberately not captured separately, so they take
; the @string colour. A bare `'` is plain text or part of an escape.

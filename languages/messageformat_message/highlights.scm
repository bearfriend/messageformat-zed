; Highlights for bare messages (the `messageformat_message` grammar), used for
; injections. This is the subset of ../../queries/highlights.scm that applies
; when the root is a message instead of a resource file.

; Quoted and template strings inside plural / select case bodies
(plural_case_body (quoted_string) @string)
(plural_case_body (template_string) @string)
(select_case_body (quoted_string) @string)
(select_case_body (template_string) @string)

; Arguments
(placeholder (identifier) @variable)
(selector (identifier) @variable)
(complex_message (identifier) @variable)

; Complex message keywords
[(plural) (select) (selectordinal)] @keyword
"offset:" @keyword

; Format types and styles
["number" "date" "time"] @type
(style_format) @constant.builtin

; Plural keys
(plural_key ["zero" "one" "two" "few" "many" "other"]) @constant.builtin

; Select keys (`other` is the required fallback)
(select_key (identifier) @constant)
(select_key "other" @constant.builtin)

; Numbers
(number) @number

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
"=" @operator
"/" @operator
"," @punctuation.delimiter
["{" "}" "<" ">"] @punctuation.bracket

; Inject messageformat syntax into strings that look like they contain messageformat patterns
((string_content) @injection.content
 (#match? @injection.content "\\{.+[,}]")
 (#set! injection.language "messageformat"))

; Handle template literals in JavaScript/TypeScript
((template_string) @injection.content
 (#match? @injection.content "\\{.+[,}]")
 (#set! injection.language "messageformat"))

; Handle raw strings in various languages
((raw_string) @injection.content
 (#match? @injection.content "\\{.+[,}]")
 (#set! injection.language "messageformat"))

; Match strings that are arguments to common i18n function calls
(call_expression
  function: ((identifier) @_function (#match? @_function "(formatMessage|t|i18n)"))
  arguments: ((string) @injection.content
    (#set! injection.language "messageformat")))

; Match object properties that are likely to contain messageformat strings
(pair
  key: ((property_identifier) @_key (#match? @_key "(message|defaultMessage|text)"))
  value: ((string) @injection.content
    (#set! injection.language "messageformat")))
; Brackets for bare messages. A lone `'` is plain text (an apostrophe) in this
; grammar, so unlike the resource-file grammar it is deliberately not paired.
("{" @open "}" @close)
("<" @open ">" @close)

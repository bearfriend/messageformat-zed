// MessageFormat sample for manually checking highlighting in Zed
export default {
	simple: "This is a simple message",
	welcome: "Hello, {name}!",
	items: `{itemCount, plural, =0 {No items} one {# item} other {# items}}`,
	offset: `{n, plural, offset:1 =0 {Nobody} one {{n} guest} other {{n} guests}}`,
	notification: "{gender, select, male {He} female {She} other {They}} liked your post.",
	ordinal: "{pos, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
	formats: "{n, number, percent} on {d, date, ::yyyyMMMd} at {d, time, short}",
	escaped: "Use '{' and '}' for braces, and it''s fine",
	markup: "Click <b>{action}</b> or <br/> go back",
	"quoted.key": `Template with {count, plural, one {# thing} other {# things}}`,
	nested: "{gender, select, male {He has {count, plural, one {# item} other {# items}}} other {They have {count, plural, one {# item} other {# items}}}}"
};

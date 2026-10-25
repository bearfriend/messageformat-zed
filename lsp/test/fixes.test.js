import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, entriesOf } from '../src/analyze.js';
import { applyEdits, fixesFor, rewritesFor } from '../src/fixes.js';

const wrap = (...entries) => `export default {\n${entries.map(e => `\t${e},\n`).join('')}};\n`;
/** A resource file from lines that carry their own commas and comments. */
const lines = (...entries) => `export default {\n${entries.map(e => `\t${e}\n`).join('')}};\n`;
const SOURCE = { locale: 'en', contents: lines('hello: "Hello", // greeting', 'bye: "Goodbye",') };

/** Applies the one fix offered for the first diagnostic with `code`, and returns the new text and what analysis says about it. */
function fix(doc, code, { file = 'fr.mf.js', source, title } = {}) {
	const before = analyze(doc, file, { source });
	const diagnostic = before.find(d => d.code === code);
	assert.ok(diagnostic, `expected a "${code}" diagnostic, got ${JSON.stringify(before.map(d => d.code))}`);
	const fixes = fixesFor(doc, diagnostic);
	const chosen = title === undefined ? fixes : fixes.filter(f => f.title === title);
	assert.equal(chosen.length, 1, `expected exactly one fix for "${code}", got ${JSON.stringify(fixes.map(f => f.title))}`);
	const text = applyEdits(doc, chosen[0].edits);
	const after = analyze(text, file, { source });
	return { text, fixes: chosen, before, after };
}

/** The fixes offered for the first diagnostic with `code`, without applying any. */
function offered(doc, code, { file = 'fr.mf.js', source } = {}) {
	const diagnostic = analyze(doc, file, { source }).find(d => d.code === code);
	assert.ok(diagnostic, `expected a "${code}" diagnostic`);
	return fixesFor(doc, diagnostic);
}

const codes = diagnostics => diagnostics.map(d => d.code).sort();

test('applyEdits applies several edits regardless of their order', () => {
	const edits = [{ start: 6, end: 11, newText: 'there' }, { start: 0, end: 5, newText: 'Hi' }];
	assert.equal(applyEdits('Hello world', edits), 'Hi there');
	assert.equal(applyEdits('Hello world', edits.toReversed()), 'Hi there');
});

test('fixesFor returns nothing for diagnostics it cannot fix', () => {
	const doc = wrap('a: "Hello {name"');
	const [parse] = analyze(doc, 'en.mf.js').filter(d => d.code === 'parse');
	assert.ok(parse);
	assert.deepEqual(fixesFor(doc, parse), []);
	assert.deepEqual(fixesFor(doc, { start: 0, end: 1, code: 'no-such-code' }), []);
});

// --- nbsp ------------------------------------------------------------------------------------

test('nbsp: replaces a non-breaking space in the structure with a normal space', () => {
	const doc = wrap('a: "{n,\u00a0plural, one {x} other {y}}"');
	const { text, fixes, after } = fix(doc, 'nbsp', { file: 'en.mf.js' });
	assert.equal(fixes[0].title, 'Replace non-breaking space with a space');
	assert.equal(text, wrap('a: "{n, plural, one {x} other {y}}"'));
	assert.deepEqual(after, []);
});

test('nbsp: leaves non-breaking spaces in translatable text alone', () => {
	const doc = wrap('a: "Price:\u00a0{n,\u00a0number}"');
	const { text } = fix(doc, 'nbsp', { file: 'en.mf.js' });
	assert.equal(text, wrap('a: "Price:\u00a0{n, number}"'));
});

test('nbsp: fixes only the diagnostic it was asked about when there are several', () => {
	const doc = wrap('a: "{n,\u00a0plural,\u00a0one {x} other {y}}"');
	const diagnostics = analyze(doc, 'en.mf.js').filter(d => d.code === 'nbsp');
	assert.equal(diagnostics.length, 2);
	const text = applyEdits(doc, fixesFor(doc, diagnostics[0])[0].edits);
	assert.equal(analyze(text, 'en.mf.js').filter(d => d.code === 'nbsp').length, 1);
	assert.equal(text, wrap('a: "{n, plural,\u00a0one {x} other {y}}"'));
});

test('nbsp: does not offer a fix if the character is no longer a non-breaking space', () => {
	const doc = wrap('a: "{n,\u00a0plural, one {x} other {y}}"');
	const [diagnostic] = analyze(doc, 'en.mf.js').filter(d => d.code === 'nbsp');
	assert.deepEqual(fixesFor(doc.replace('\u00a0', ' '), diagnostic), []);
});

// --- untranslated ----------------------------------------------------------------------------

test('untranslated: adds the marker after the entry and the warning goes away', () => {
	const doc = lines('hello: "Hello",', 'bye: "Au revoir",');
	const { text, fixes, after } = fix(doc, 'untranslated', { source: SOURCE });
	assert.equal(fixes[0].title, 'Mark as sufficiently translated (mfv-translated;)');
	assert.equal(text, lines('hello: "Hello", // mfv-translated;', 'bye: "Au revoir",'));
	assert.deepEqual(codes(after), []);
});

test('untranslated: works without a trailing comma on the last entry', () => {
	const doc = lines('bye: "Goodbye"');
	const { text, after } = fix(doc, 'untranslated', { source: { locale: 'en', contents: doc } });
	assert.equal(text, lines('bye: "Goodbye" // mfv-translated;'));
	assert.deepEqual(codes(after), []);
});

test('untranslated: puts the marker at the start of an existing comment instead of adding a second one', () => {
	const doc = lines('hello: "Hello", // keep as is', 'bye: "Au revoir",');
	const { text, after } = fix(doc, 'untranslated', { source: SOURCE });
	assert.equal(text, lines('hello: "Hello", // mfv-translated; keep as is', 'bye: "Au revoir",'));
	assert.deepEqual(codes(after), []);
});

test('untranslated: an existing comment with no space after the slashes gets one', () => {
	const doc = lines('hello: "Hello", //keep as is', 'bye: "Au revoir",');
	const { text, after } = fix(doc, 'untranslated', { source: SOURCE });
	assert.equal(text, lines('hello: "Hello", // mfv-translated; keep as is', 'bye: "Au revoir",'));
	assert.deepEqual(codes(after), []);
});

test('untranslated: an empty comment is filled in without leaving trailing whitespace', () => {
	const doc = lines('hello: "Hello", //   ', 'bye: "Au revoir",');
	const { text, after } = fix(doc, 'untranslated', { source: SOURCE });
	assert.equal(text, lines('hello: "Hello", // mfv-translated;', 'bye: "Au revoir",'));
	assert.deepEqual(codes(after), []);
});

test('untranslated: a URL inside the message is not mistaken for a comment', () => {
	const doc = lines('link: "See http://example.com",');
	const { text, after } = fix(doc, 'untranslated', { source: { locale: 'en', contents: doc } });
	assert.equal(text, lines('link: "See http://example.com", // mfv-translated;'));
	assert.deepEqual(codes(after), []);
});

test('untranslated: puts the marker at the end of the line a multi-line message ends on', () => {
	const entry = 'items: `{n, plural,\n\t\tone {# item}\n\t\tother {# items}\n\t}`,';
	const source = { locale: 'en', contents: lines(entry) };
	const { text, after } = fix(lines(entry), 'untranslated', { source, file: 'de.mf.js' });
	assert.equal(text, lines(`${entry} // mfv-translated;`));
	assert.deepEqual(codes(after), []);
});

test('untranslated: keeps CRLF line endings', () => {
	const crlf = s => s.replaceAll('\n', '\r\n');
	const doc = crlf(lines('hello: "Hello",', 'bye: "Au revoir",'));
	const { text, after } = fix(doc, 'untranslated', { source: { locale: 'en', contents: crlf(SOURCE.contents) } });
	assert.equal(text, crlf(lines('hello: "Hello", // mfv-translated;', 'bye: "Au revoir",')));
	assert.deepEqual(codes(after), []);
});

test('untranslated: an entry on the last line of the file, with no trailing newline', () => {
	const doc = 'export default {\n\thello: "Hello",';
	const source = { locale: 'en', contents: doc };
	const { text, after } = fix(doc, 'untranslated', { source });
	assert.equal(text, 'export default {\n\thello: "Hello", // mfv-translated;');
	assert.deepEqual(codes(after), []);
});

test('untranslated: plain .mf files work the same way', () => {
	const doc = '// strings\n' + lines('hello: "Hello",');
	const { text, after } = fix(doc, 'untranslated', { source: { locale: 'en', contents: doc }, file: 'fr.mf' });
	assert.equal(text, '// strings\n' + lines('hello: "Hello", // mfv-translated;'));
	assert.deepEqual(codes(after), []);
});

// --- argument (uses mfv's formatter) ---------------------------------------------------------

const sourceOf = (...entries) => ({ locale: 'en', contents: lines(...entries) });

test('argument: corrects a misspelt argument name using the source message', () => {
	const source = sourceOf('hello: "Hello {name}"');
	const { text, fixes, after } = fix(lines('hello: "Bonjour {Name}"'), 'argument', { source });
	assert.equal(fixes[0].title, 'Correct argument names using the source message');
	assert.equal(text, lines('hello: "Bonjour {name}"'));
	assert.deepEqual(codes(after), []);
});

test('argument: changes nothing but the name, even in a message the formatter would normally rewrite', () => {
	const source = sourceOf('items: "{n, plural, one {# item} other {# items}}"');
	const doc = lines('items: "It\'s {N, plural, other {# Artikel} one {# Artikel}}"');
	const { text, after } = fix(doc, 'argument', { source, file: 'de.mf.js' });
	assert.equal(text, lines('items: "It\'s {n, plural, other {# Artikel} one {# Artikel}}"'));
	assert.deepEqual(codes(after), []);
});

test('argument: keeps escaped quotes escaped', () => {
	const source = sourceOf('a: "Say \\"hi\\" {name}"');
	const { text, after } = fix(lines('a: "Dis \\"salut\\" {Name}"'), 'argument', { source });
	assert.equal(text, lines('a: "Dis \\"salut\\" {name}"'));
	assert.deepEqual(codes(after), []);
});

test('argument: keeps the layout of a multi-line message', () => {
	const entry = arg => `items:\n\t\t\`{${arg}, plural,\n\t\t\tone {# Artikel}\n\t\t\tother {# Artikel}\n\t\t}\`,`;
	const source = sourceOf('items: "{n, plural, one {# item} other {# items}}"');
	const { text, after } = fix(lines(entry('N')), 'argument', { source, file: 'de.mf.js' });
	assert.equal(text, lines(entry('n')));
	assert.deepEqual(codes(after), []);
});

test('argument: offers nothing when the right name is ambiguous', () => {
	const source = sourceOf('names: "{first} {last}"');
	assert.deepEqual(offered(lines('names: "{frst} {lst}"'), 'argument', { source }), []);
});

// --- category (rename or remove) -------------------------------------------------------------

test('category: renames an unsupported category when exactly one supported category is unused', () => {
	const doc = wrap('a: "{n, plural, one {x} \u0905\u0928\u094d\u092f {\u091a}}"');
	const { text, fixes, after } = fix(doc, 'category', { file: 'en.mf.js', title: 'Rename unsupported plural category' });
	assert.equal(fixes[0].title, 'Rename unsupported plural category');
	assert.equal(text, wrap('a: "{n, plural, one {x} other {\u091a}}"'));
	assert.deepEqual(codes(after), []);
});

test('category: removes an unsupported category when there is nothing to rename it to', () => {
	const doc = wrap('a: "{n, plural, one {x} few {y} other {z}}"');
	const { text, fixes, after } = fix(doc, 'category', { file: 'en.mf.js' });
	assert.equal(fixes[0].title, 'Remove unsupported plural categories');
	assert.equal(text, wrap('a: "{n, plural, one {x} other {z}}"'));
	assert.deepEqual(codes(after), []);
});

test('category: leaves the order and spacing of everything else alone', () => {
	const doc = wrap('a: "It\'s {n, plural, other {z} few {y} one {x}}"');
	const { text } = fix(doc, 'category', { file: 'en.mf.js' });
	assert.equal(text, wrap('a: "It\'s {n, plural, other {z} one {x}}"'));
});

test('category: offers both renaming and removing when either would improve the message', () => {
	const doc = wrap('a: "{n, plural, one {x} few {y}}"');
	assert.deepEqual(offered(doc, 'category', { file: 'en.mf.js' }).map(f => f.title).sort(), ['Remove unsupported plural categories', 'Rename unsupported plural category']);
	assert.equal(fix(doc, 'category', { file: 'en.mf.js', title: 'Rename unsupported plural category' }).text, wrap('a: "{n, plural, one {x} other {y}}"'));
	assert.equal(fix(doc, 'category', { file: 'en.mf.js', title: 'Remove unsupported plural categories' }).text, wrap('a: "{n, plural, one {x}}"'));
});

test('category: removing the only case turns it into `other`', () => {
	const doc = wrap('a: "{n, plural, few {y}}"');
	const { text, after } = fix(doc, 'category', { file: 'en.mf.js', title: 'Remove unsupported plural categories' });
	assert.equal(text, wrap('a: "{n, plural, other {y}}"'));
	assert.deepEqual(codes(after), ['category-missing']);
});

// --- category-missing and other (add) --------------------------------------------------------

test('category-missing: adds the missing categories, copying `other`, in the usual order', () => {
	const doc = wrap('a: "{n, plural, one {x} other {y}}"');
	const { text, fixes, after } = fix(doc, 'category-missing', { file: 'ru.mf.js' });
	assert.equal(fixes[0].title, 'Add missing plural categories');
	assert.equal(text, wrap('a: "{n, plural, one {x} few {y} many {y} other {y}}"'));
	assert.deepEqual(codes(after), []);
});

test('other: adds the missing `other` to a plural, copying its last case', () => {
	const doc = wrap('a: "{n, plural, one {x}}"');
	const { text, after } = fix(doc, 'other', { file: 'de.mf.js' });
	assert.equal(text, wrap('a: "{n, plural, one {x} other {x}}"'));
	assert.deepEqual(codes(after), []);
});

test('other: puts the cases in the usual order, exact matches first', () => {
	const doc = wrap('a: "{n, plural, one {x} =0 {z}}"');
	assert.equal(fix(doc, 'other', { file: 'en.mf.js' }).text, wrap('a: "{n, plural, =0 {z} one {x} other {z}}"'));
});

test('other: adds the missing `other` to a select, copying its last case', () => {
	const doc = wrap('a: "{g, select, male {He} female {She}}"');
	const { text, fixes, after } = fix(doc, 'other', { file: 'en.mf.js' });
	assert.equal(fixes[0].title, 'Add missing cases');
	assert.equal(text, wrap('a: "{g, select, male {He} female {She} other {She}}"'));
	assert.deepEqual(codes(after), []);
});

test('other: is not offered when adding it would only create a new error (misspelt argument)', () => {
	const source = sourceOf('g: "{g, select, male {He} other {They}}"');
	const doc = lines('g: "{G, select, male {Il}}"');
	const diagnostics = codes(analyze(doc, 'fr.mf.js', { source }));
	assert.ok(diagnostics.includes('other') && diagnostics.includes('argument'));
	assert.deepEqual(offered(doc, 'other', { source }), []);
	// once the argument is right, it is
	const { text } = fix(doc, 'argument', { source });
	assert.equal(fix(text, 'other', { source }).text, lines('g: "{g, select, male {Il} other {Il}}"'));
});

// --- option-missing (add options the source has) ---------------------------------------------

const GENDER = () => sourceOf('g: "{g, select, male {He} female {She} other {They}}"');

test('option-missing: adds the select options the source message has, copying `other`, and the warning goes away', () => {
	const source = GENDER();
	const { text, fixes, after } = fix(lines('g: "{g, select, male {Il} other {Ils}}"'), 'option-missing', { source });
	assert.equal(fixes[0].title, 'Add options that the source message has');
	assert.equal(text, lines('g: "{g, select, male {Il} female {Ils} other {Ils}}"'));
	assert.deepEqual(codes(after), []);
});

test('option-missing: also supplies a missing `other`, and offers its own fix alongside the `other` fix', () => {
	const source = GENDER();
	const doc = lines('g: "{g, select, male {Il}}"');
	assert.deepEqual(offered(doc, 'other', { source }).map(f => f.title), ['Add missing cases']);
	const { text, after } = fix(doc, 'option-missing', { source });
	assert.equal(text, lines('g: "{g, select, male {Il} female {Il} other {Il}}"'));
	assert.deepEqual(codes(after), []);
});

test('option-missing: does not rename arguments, which is the `argument` fix\'s business', () => {
	const source = GENDER();
	const doc = lines('g: "{G, select, male {Il}}"');
	assert.ok(analyze(doc, 'fr.mf.js', { source }).some(d => d.code === 'option-missing'));
	assert.deepEqual(offered(doc, 'option-missing', { source }), []);
});

test('option-missing: fixes the select without touching the rest, apart from the plural categories `add` always adds', () => {
	const source = sourceOf('m: "{g, select, male {He} female {She} other {They}} has {n, plural, one {# item} other {# items}}"');
	const doc = lines('m: "{g, select, other {Ils}} a {n, plural, one {# objet} other {# objets}}"');
	const [first, ...rest] = offered(doc, 'option-missing', { source });
	assert.ok(first);
	assert.deepEqual(rest.map(f => f.edits), rest.map(() => first.edits), 'one fix per missing option, all the same edit');
	const text = applyEdits(doc, first.edits);
	assert.equal(text, lines('m: "{g, select, male {Ils} female {Ils} other {Ils}} a {n, plural, one {# objet} many {# objets} other {# objets}}"'));
	assert.ok(!codes(analyze(text, 'fr.mf.js', { source })).includes('option-missing'));
});

test('option-missing: offers nothing for an entry that has no source to compare with', () => {
	const doc = lines('g: "{g, select, male {Il} other {Ils}}"');
	const [entry] = entriesOf(doc, 'fr.mf.js');
	assert.equal(entry.source, undefined);
	assert.deepEqual(fixesFor(doc, { code: 'option-missing', start: entry.start, end: entry.end, entry }).map(f => f.title), []);
});

// --- format message (refactor, not tied to a diagnostic) -------------------------------------

test('rewritesFor: offers to format a message with mfv (hoisting selectors, as `mfv format` does), as a rewrite', () => {
	const doc = wrap('a: "It\'s {n, plural, other {x} one {y}}"');
	const [entry] = entriesOf(doc, 'en.mf.js');
	const rewrites = rewritesFor(entry);
	assert.deepEqual(rewrites.map(r => [r.title, r.kind]), [['Format message with mfv', 'refactor.rewrite']]);
	const text = applyEdits(doc, rewrites[0].edits);
	assert.equal(text, wrap('a: "{n, plural, one {It\u2019s y} other {It\u2019s x}}"'));
	assert.deepEqual(analyze(text, 'en.mf.js'), []);
});

test('rewritesFor: offers nothing for a message that is already formatted', () => {
	const [entry] = entriesOf(wrap('a: "Hello {name}"'), 'en.mf.js');
	assert.deepEqual(rewritesFor(entry), []);
});

test('rewritesFor: offers nothing for a message that does not parse', () => {
	const [entry] = entriesOf(wrap('a: "Hello {name"'), 'en.mf.js');
	assert.deepEqual(rewritesFor(entry), []);
});

test('rewritesFor: keeps escaped quotes escaped and uses the entry layout', () => {
	const doc = wrap('a: "Say \\"hi\\" to {n, plural, other {x} one {y}}"');
	const [entry] = entriesOf(doc, 'en.mf.js');
	assert.equal(applyEdits(doc, rewritesFor(entry)[0].edits), wrap('a: "{n, plural, one {Say \\"hi\\" to y} other {Say \\"hi\\" to x}}"'));
});

// --- safety: rewrites must never change what a message means -----------------------------------

test('argument: keeps skeleton options such as `::currency/USD`', () => {
	const source = sourceOf('price: "{n, number, ::currency/USD}"');
	const doc = lines('price: "{N, number, ::currency/USD}"');
	assert.ok(analyze(doc, 'fr.mf.js', { source }).some(d => d.code === 'argument'));
	const { text, after } = fix(doc, 'argument', { source });
	assert.equal(text, lines('price: "{n, number, ::currency/USD}"'));
	assert.deepEqual(codes(after), []);
});

test('argument: keeps a quoted `#` in a plural quoted', () => {
	const source = sourceOf("items: \"{n, plural, one {# '#' item} other {# items}}\"");
	const doc = lines("items: \"{N, plural, one {# '#' Artikel} other {# Artikel}}\"");
	assert.ok(analyze(doc, 'de.mf.js', { source }).some(d => d.code === 'argument'));
	const { text, after } = fix(doc, 'argument', { source, file: 'de.mf.js' });
	assert.equal(text, lines("items: \"{n, plural, one {# '#' Artikel} other {# Artikel}}\""));
	assert.deepEqual(codes(after), []);
	assert.deepEqual(rewritesFor(entriesOf(doc, 'de.mf.js')[0]), [], 'already formatted');
});

test('rewrites are still offered when reprinting only changes how the same text is written', () => {
	const source = sourceOf("a: \"don''t {name}\"");
	const { text } = fix(lines("a: \"ne {Name}''est pas\""), 'argument', { source });
	assert.equal(text, lines('a: "ne {name}\'est pas"'));
});

test('argument: is not offered when only some of the names could be corrected', () => {
	const source = sourceOf('names: "{a} {b}"');
	const doc = lines('names: "{a} {B} {zz}"');
	assert.ok(analyze(doc, 'fr.mf.js', { source }).some(d => d.code === 'argument'));
	assert.deepEqual(offered(doc, 'argument', { source }), []);
});

test('rewritesFor: closes an unterminated quote rather than changing what the message says', () => {
	const doc = wrap('a: "x \'{{ y {n}"');
	assert.deepEqual(analyze(doc, 'en.mf.js'), []);
	const text = applyEdits(doc, rewritesFor(entriesOf(doc, 'en.mf.js')[0])[0].edits);
	assert.equal(text, wrap('a: "x \'{{ y {n}\'"'));
	assert.deepEqual(analyze(text, 'en.mf.js'), []);
});

test('rewritesFor: formatting a message does not also correct its argument names', () => {
	const source = sourceOf('hello: "Hello {name}"');
	const doc = lines('hello: "It\'s {Name}, {n, plural, other {x} one {y}}"');
	const [entry] = entriesOf(doc, 'fr.mf.js', { source });
	assert.ok(entry.source);
	const text = applyEdits(doc, rewritesFor(entry)[0].edits);
	assert.equal(text, lines('hello: "{n, plural, one {It\u2019s {Name}, y} other {It\u2019s {Name}, x}}"'));
	assert.ok(analyze(text, 'fr.mf.js', { source }).some(d => d.code === 'argument'), 'still reported, for the argument fix to handle');
});

const REMOVE = 'Remove unsupported plural categories';

test('single-quoted and backtick messages keep their own escaped quote', () => {
	const single = lines("a: 'Say \\'hi\\' {n, plural, one {x} few {y} other {z}}'");
	assert.equal(fix(single, 'category', { file: 'en.mf.js', title: REMOVE }).text, lines("a: 'Say \\'hi\\' {n, plural, one {x} other {z}}'"));

	const tick = lines('a: `Say \\`hi\\` {n, plural, one {x} few {y} other {z}}`');
	assert.equal(fix(tick, 'category', { file: 'en.mf.js', title: REMOVE }).text, lines('a: `Say \\`hi\\` {n, plural, one {x} other {z}}`'));
});

test('quote characters other than the message\'s own are not escaped by a fix', () => {
	const single = lines("a: 'Say \"hi\" {n, plural, one {x} few {y} other {z}}'");
	assert.equal(fix(single, 'category', { file: 'en.mf.js', title: REMOVE }).text, lines("a: 'Say \"hi\" {n, plural, one {x} other {z}}'"));

	const tick = lines('a: `Say "hi" and \'it\' {n, plural, one {x} few {y} other {z}}`');
	assert.equal(fix(tick, 'category', { file: 'en.mf.js', title: REMOVE }).text, lines('a: `Say "hi" and \'it\' {n, plural, one {x} other {z}}`'));
});

test('rewritesFor: works on single-quoted and backtick messages', () => {
	const single = lines("a: 'Say hi to {n, plural, other {x} one {y}}'");
	assert.equal(applyEdits(single, rewritesFor(entriesOf(single, 'en.mf.js')[0])[0].edits), lines("a: '{n, plural, one {Say hi to y} other {Say hi to x}}'"));

	const tick = lines('a: `Say hi to {n, plural, other {x} one {y}}`');
	assert.equal(applyEdits(tick, rewritesFor(entriesOf(tick, 'en.mf.js')[0])[0].edits), lines('a: `{n, plural, one {Say hi to y} other {Say hi to x}}`'));
});

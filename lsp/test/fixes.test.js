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

test('rewritesFor: closes an unterminated escape run rather than changing what the message says', () => {
	const doc = wrap('a: "x \'{{ y {n}"');
	assert.deepEqual(codes(analyze(doc, 'en.mf.js')), ['escape']);
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

// --- escape ----------------------------------------------------------------------------------

const CLOSE = `Close the escape run with "'"`;

test('escape: closes the run at the end of the message and the warning goes away', () => {
	const { text, fixes, after } = fix(wrap('a: "l\'<b>abc</b>"'), 'escape', { file: 'en.mf.js' });
	assert.equal(fixes[0].title, CLOSE);
	assert.equal(text, wrap('a: "l\'<b>abc</b>\'"'));
	assert.deepEqual(after, []);
});

test('escape: closes the run before the brace of the case it is in, and fixes only the run it was asked about', () => {
	const doc = wrap('a: "{n, plural, one {l\'<b>abc</b>} other {l\'<b>abc</b>}}"');
	const { text, after } = fix(doc, 'escape', { file: 'en.mf.js' });
	assert.equal(text, wrap('a: "{n, plural, one {l\'<b>abc</b>\'} other {l\'<b>abc</b>}}"'));
	// The other run is still there, and with the first one closed it has nothing to be closed by, so the message no longer parses.
	assert.deepEqual(codes(after), ['escape', 'parse']);
	const again = fix(text, 'escape', { file: 'en.mf.js' });
	assert.equal(again.text, wrap('a: "{n, plural, one {l\'<b>abc</b>\'} other {l\'<b>abc</b>\'}}"'));
	assert.deepEqual(again.after, []);
});

test('escape: fixes a message that does not parse because of the run', () => {
	const { text, before, after } = fix(wrap('a: "{n, plural, one {a \'<b>x} other {y}}"'), 'escape', { file: 'en.mf.js' });
	assert.deepEqual(codes(before), ['escape', 'parse']);
	assert.equal(text, wrap('a: "{n, plural, one {a \'<b>x\'} other {y}}"'));
	assert.deepEqual(after, []);
});

test('escape: the apostrophe it adds is escaped in a single-quoted string, and not in the others', () => {
	const single = fix(lines("a: 'l\\'<b>abc</b>'"), 'escape', { file: 'en.mf.js' });
	assert.equal(single.text, lines("a: 'l\\'<b>abc</b>\\''"));
	assert.deepEqual(single.after, []);
	const tick = fix(lines('a: `l\'<b>abc</b>`'), 'escape', { file: 'en.mf.js' });
	assert.equal(tick.text, lines('a: `l\'<b>abc</b>\'`'));
});

test('escape: a message that does not end the line is closed where the message ends', () => {
	const { text } = fix(lines('a: "x \'{y", // note', 'b: "ok",'), 'escape', { file: 'en.mf.js' });
	assert.equal(text, lines('a: "x \'{y\'", // note', 'b: "ok",'));
});

test('escape: with an escaped apostrophe before the run, the fix still lands at the end of the run', () => {
	const doc = lines("a: 'it\\'s \\'<b>x</b> and more'");
	const { text, after } = fix(doc, 'escape', { file: 'en.mf.js' });
	assert.equal(text, lines("a: 'it\\'s \\'<b>x</b> and more\\''"));
	assert.deepEqual(after, []);
});

test('escape: offers the fix for the run it was asked about, not the first one in the message', () => {
	const doc = wrap('a: "{n, plural, one {l\'<b>abc</b>} other {l\'<b>abc</b>}}"');
	const [first, second] = analyze(doc, 'en.mf.js').filter(d => d.code === 'escape');
	const closing = doc.indexOf('} other');
	assert.deepEqual(fixesFor(doc, first)[0].edits.map(e => e.start), [closing]);
	assert.deepEqual(fixesFor(doc, second)[0].edits.map(e => e.start), [doc.lastIndexOf('}}')]);
});

test('escape: offers nothing for a diagnostic that is not at a run, or has no entry', () => {
	const doc = wrap('a: "l\'<b>abc</b>"');
	const [diagnostic] = analyze(doc, 'en.mf.js');
	assert.deepEqual(fixesFor(doc, { ...diagnostic, start: diagnostic.start + 1 }), []);
	assert.deepEqual(fixesFor(doc, { ...diagnostic, entry: undefined }), []);
});

// --- extraneous and duplicate ----------------------------------------------------------------

const REMOVE_EXTRANEOUS = 'Remove this message, which the source does not have';
const REMOVE_DUPLICATE = 'Remove this duplicate message';

test('extraneous: removes the whole entry, with its comma and comment, and nothing else', () => {
	const source = sourceOf('hello: "Hello"', 'bye: "Bye"');
	const doc = lines('hello: "Bonjour",', 'old: "Ancien", // dropped from the app', 'bye: "Au revoir",');
	const { text, fixes, after } = fix(doc, 'extraneous', { file: 'fr.mf.js', source });
	assert.equal(fixes[0].title, REMOVE_EXTRANEOUS);
	assert.equal(text, lines('hello: "Bonjour",', 'bye: "Au revoir",'));
	assert.deepEqual(after, []);
});

test('extraneous: removes a multi-line message in full', () => {
	const source = sourceOf('hello: "Hello"', 'bye: "Bye"');
	const doc = lines('hello: "Bonjour",', 'old: `Ligne un\n\t\tligne deux`, // note', 'bye: "Au revoir",');
	const { text, after } = fix(doc, 'extraneous', { source });
	assert.equal(text, lines('hello: "Bonjour",', 'bye: "Au revoir",'));
	assert.deepEqual(after, []);
});

test('extraneous: removes the last entry, which has no comma, and the first', () => {
	const source = sourceOf('hello: "Hello"');
	assert.equal(fix(lines('hello: "Bonjour",', 'old: "Ancien"'), 'extraneous', { source }).text, lines('hello: "Bonjour",'));
	assert.equal(fix(lines('old: "Ancien",', 'hello: "Bonjour",'), 'extraneous', { source }).text, lines('hello: "Bonjour",'));
});

test('extraneous: fixes only the entry it was asked about', () => {
	const source = sourceOf('hello: "Hello"');
	const { text, after } = fix(lines('hello: "Bonjour",', 'one: "Un",', 'two: "Deux",'), 'extraneous', { source });
	assert.equal(text, lines('hello: "Bonjour",', 'two: "Deux",'));
	assert.deepEqual(codes(after), ['extraneous']);
});

test('extraneous: keeps the line endings of the file', () => {
	const source = sourceOf('hello: "Hello"');
	const doc = lines('hello: "Bonjour",', 'old: "Ancien",').replaceAll('\n', '\r\n');
	assert.equal(fix(doc, 'extraneous', { source }).text, lines('hello: "Bonjour",').replaceAll('\n', '\r\n'));
});

test('extraneous: offers nothing for an entry that shares its line with something other than whitespace', () => {
	const source = sourceOf('hello: "Hello"');
	const doc = 'export default { old: "Ancien",\n\thello: "Bonjour",\n};\n';
	assert.deepEqual(offered(doc, 'extraneous', { source }), []);
});

test('duplicate: removes the later definition and keeps the first', () => {
	const doc = lines('a: "one",', 'b: "two",', 'a: "uno", // again');
	const { text, fixes, after } = fix(doc, 'duplicate', { file: 'en.mf.js' });
	assert.equal(fixes[0].title, REMOVE_DUPLICATE);
	assert.equal(text, lines('a: "one",', 'b: "two",'));
	assert.deepEqual(after, []);
});

test('duplicate: removes a quoted key and a multi-line message in full', () => {
	const doc = lines('a: "one",', '"a": `uno\n\t\tdos`, // again', 'b: "two",');
	const { text, after } = fix(doc, 'duplicate', { file: 'en.mf.js' });
	assert.equal(text, lines('a: "one",', 'b: "two",'));
	assert.deepEqual(after, []);
});

test('duplicate: with three definitions removes only the one it was asked about', () => {
	const doc = lines('a: "one",', 'a: "two",', 'a: "three",');
	const diagnostics = analyze(doc, 'en.mf.js').filter(d => d.code === 'duplicate');
	assert.equal(diagnostics.length, 2);
	const second = applyEdits(doc, fixesFor(doc, diagnostics[1])[0].edits);
	assert.equal(second, lines('a: "one",', 'a: "two",'));
	const first = applyEdits(doc, fixesFor(doc, diagnostics[0])[0].edits);
	assert.equal(first, lines('a: "one",', 'a: "three",'));
});

test('duplicate: removes the last entry, which has no comma', () => {
	const doc = lines('a: "one",', 'a: "uno"');
	assert.equal(fix(doc, 'duplicate', { file: 'en.mf.js' }).text, lines('a: "one",'));
});

test('duplicate: keeps the line endings of the file', () => {
	const doc = lines('a: "one",', 'b: "two",', 'a: "uno",').replaceAll('\n', '\r\n');
	assert.equal(fix(doc, 'duplicate', { file: 'en.mf.js' }).text, lines('a: "one",', 'b: "two",').replaceAll('\n', '\r\n'));
});

// --- missing ---------------------------------------------------------------------------------

test('missing: copies the missing messages after the entry that precedes them in the source', () => {
	const source = sourceOf('a: "A"', 'b: "B {n}"', 'c: "C"', 'd: "D"');
	const { text, fixes, before, after } = fix(lines('a: "Un",', 'd: "De",'), 'missing', { source });
	assert.equal(fixes[0].title, 'Add the 2 missing messages, copied from en');
	assert.equal(text, lines('a: "Un",', 'b: "B {n}",', 'c: "C",', 'd: "De",'));
	assert.ok(!codes(before).includes('untranslated'));
	assert.deepEqual(codes(after), ['untranslated', 'untranslated'], 'the copies are identical to the source, so they are listed as still to translate');
});

test('missing: puts messages that come first in the source before the first entry, and keeps the order of the source', () => {
	const source = sourceOf('a: "A"', 'b: "B"', 'c: "C"', 'd: "D"');
	const { text } = fix(lines('c: "Ce",'), 'missing', { source });
	assert.equal(text, lines('a: "A",', 'b: "B",', 'c: "Ce",', 'd: "D",'));
});

test('missing: adds the comma that the entry it follows lacks', () => {
	const source = sourceOf('a: "A"', 'b: "B"');
	assert.equal(fix(lines('a: "Un"'), 'missing', { source }).text, lines('a: "Un",', 'b: "B",'));
	assert.equal(fix(lines('a: "Un" // note'), 'missing', { source }).text, lines('a: "Un", // note', 'b: "B",'));
	assert.equal(fix(lines('a: "Un", // note'), 'missing', { source }).text, lines('a: "Un", // note', 'b: "B",'));
});

test('missing: follows a multi-line entry', () => {
	const source = sourceOf('a: "A"', 'b: "B"');
	assert.equal(fix(lines('a: `Un\n\t\tdeux`, // note'), 'missing', { source }).text, lines('a: `Un\n\t\tdeux`, // note', 'b: "B",'));
});

test('missing: copies the key and message as the source wrote them, but not its comment', () => {
	const source = { locale: 'en', contents: lines("'it\\'s': 'It\\'s {x}', // for the header", '"a-b": `Line one\n\t\tline two`,', 'plain: "P"') };
	const { text } = fix(lines('plain: "Pe",'), 'missing', { source });
	assert.equal(text, lines("'it\\'s': 'It\\'s {x}',", '"a-b": `Line one\n\t\tline two`,', 'plain: "Pe",'));
});

test('missing: indents the copies like the entries of the file', () => {
	const source = sourceOf('a: "A"', 'b: "B"', 'c: "C"');
	const doc = 'export default {\n  b: "Be",\n};\n';
	assert.equal(fix(doc, 'missing', { source }).text, 'export default {\n  a: "A",\n  b: "Be",\n  c: "C",\n};\n');
});

test('missing: keeps the line endings of the file', () => {
	const source = sourceOf('a: "A"', 'b: "B"', 'c: "C"');
	const doc = lines('b: "Be"').replaceAll('\n', '\r\n');
	assert.equal(fix(doc, 'missing', { source }).text, lines('a: "A",', 'b: "Be",', 'c: "C",').replaceAll('\n', '\r\n'));
});

test('missing: fills a file that has no messages yet', () => {
	const source = sourceOf('a: "A"', 'b: "B"');
	assert.equal(fix('export default {\n};\n', 'missing', { source }).text, lines('a: "A",', 'b: "B",'));
});

test('missing: fills a file with no messages whatever its line endings or layout', () => {
	const source = sourceOf('a: "A"', 'b: "B"');
	assert.equal(fix('export default {\r\n};\r\n', 'missing', { source }).text, lines('a: "A",', 'b: "B",').replaceAll('\n', '\r\n'));
	assert.equal(fix('export default {};\n', 'missing', { source }).text, 'export default {\n\ta: "A",\n\tb: "B",\n};\n');
	assert.equal(fix('export default {', 'missing', { source }).text, 'export default {\n\ta: "A",\n\tb: "B",');
});

test('missing: offers nothing when there is nowhere to put the messages', () => {
	const source = sourceOf('a: "A"');
	assert.deepEqual(offered('\n', 'missing', { source }), []);
	assert.deepEqual(offered('export default { b: "Be",\n};\n', 'missing', { source: sourceOf('a: "A"', 'b: "B"') }), [], 'the first entry is on the line of the brace');
	assert.deepEqual(fixesFor('export default {\n};\n', { start: 0, end: 1, code: 'missing' }), [], 'a diagnostic with no plan');
});

test('extraneous and duplicate: leave the blank line after the entry', () => {
	const source = sourceOf('hello: "Hello"');
	assert.equal(fix('export default {\n\thello: "Bonjour",\n\told: "Ancien",\n\n\t// more\n};\n', 'extraneous', { source }).text, 'export default {\n\thello: "Bonjour",\n\n\t// more\n};\n');
	assert.equal(fix('export default {\n\ta: "one",\n\ta: "uno",\n\n\tb: "two",\n};\n', 'duplicate', { file: 'en.mf.js' }).text, 'export default {\n\ta: "one",\n\n\tb: "two",\n};\n');
});

test('duplicate: offers nothing when the document no longer has an entry where the diagnostic says', () => {
	const doc = wrap('a: "one"', 'a: "two"');
	const [diagnostic] = analyze(doc, 'en.mf.js').filter(d => d.code === 'duplicate');
	assert.deepEqual(fixesFor(doc, { ...diagnostic, entryStart: 0 }), []);
	assert.deepEqual(fixesFor(doc, { ...diagnostic, entryStart: undefined }), []);
});

test('missing: says "the missing message" for one, and copies only what is missing', () => {
	const source = sourceOf('a: "A"', 'b: "B"');
	const { fixes, text } = fix(lines('a: "Un",'), 'missing', { source });
	assert.equal(fixes[0].title, 'Add the missing message, copied from en');
	assert.equal(text, lines('a: "Un",', 'b: "B",'));
});

test('missing: names the source locale', () => {
	const source = { locale: 'en-gb', contents: lines('a: "A"', 'b: "B"') };
	assert.equal(fix(lines('a: "Un",'), 'missing', { source }).fixes[0].title, 'Add the missing message, copied from en-gb');
});

test('missing: more than the diagnostic lists are all copied', () => {
	const keys = Array.from({ length: 12 }, (_, i) => `k${i}`);
	const source = sourceOf(...keys.map(k => `${k}: "${k.toUpperCase()}"`));
	const { text } = fix(lines('k0: "Z",'), 'missing', { source });
	assert.equal(text, lines(`k0: "Z",`, ...keys.slice(1).map(k => `${k}: "${k.toUpperCase()}",`)));
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

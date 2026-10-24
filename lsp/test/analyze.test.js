import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, localeFromFileName } from '../src/analyze.js';

/** Diagnostics as `[code, severity, covered text]`, so ranges are checked, not just counts. */
function run(doc, file = 'en.mf.js') {
	return analyze(doc, file).map(d => [d.code, d.severity, doc.slice(d.start, d.end)]);
}

const wrap = (...entries) => `export default {\n${entries.map(e => `\t${e},\n`).join('')}};\n`;

test('clean resource file has no diagnostics', () => {
	const doc = wrap(
		'greeting: "Hello {name}"',
		'items: `{n, plural, one {# item} other {# items}}`',
		'pick: "{g, select, male {He} other {They}}"',
	);
	assert.deepEqual(run(doc), []);
});

test('unterminated argument is reported on the argument, in document coordinates', () => {
	const doc = wrap('ok: "fine"', 'greeting: "Hello {name"');
	assert.deepEqual(run(doc), [['parse', 'error', '{name']]);
});

test('syntax errors in a multi-line backtick message stay on the line where they start', () => {
	const doc = wrap('multi: `{g, select,\n\t\tmale {He {x}}\n\t\tfemale {She\n\t}`');
	const [d] = analyze(doc, 'en.mf.js');
	assert.equal(d.code, 'parse');
	assert.ok(!doc.slice(d.start, d.end).includes('\n'), 'range must not span lines');
	assert.ok(d.start >= doc.indexOf('{g, select'), 'range starts inside the message');
});

test('missing "other" is an error on the whole message', () => {
	const doc = wrap('pick: "{g, select, male {He} female {She}}"');
	assert.deepEqual(run(doc), [['other', 'error', '{g, select, male {He} female {She}}']]);
});

test('plural categories are checked against the file name locale', () => {
	const doc = wrap('items: "{n, plural, one {# item} other {# items}}"');
	assert.deepEqual(run(doc, 'en.mf.js'), []);
	// French has `one`, `many` and `other`; Polish additionally has `few`.
	assert.deepEqual(run(doc, 'fr-ca.mf.js'), [
		['category-missing', 'warning', '{n, plural, one {# item} other {# items}}'],
	]);
	assert.equal(run(doc, 'pl.mf.js')[0][0], 'category-missing');
});

test('unsupported plural category underlines the category name', () => {
	const doc = wrap('items: "{n, plural, =0 {none} few {a few} one {# item} other {# items}}"');
	assert.deepEqual(run(doc, 'en.mf.js'), [['category', 'error', 'few']]);
});

test('duplicate keys: every later occurrence is flagged, the first is not', () => {
	const doc = wrap('dup: "a"', 'other: "b"', 'dup: "c"', '"dup": "d"');
	const found = analyze(doc, 'en.mf.js').filter(d => d.code === 'duplicate');
	assert.equal(found.length, 2);
	assert.deepEqual(found.map(d => doc.slice(d.start, d.end)), ['dup', 'dup']);
	assert.ok(found.every(d => d.start > doc.indexOf('other')), 'first occurrence is not flagged');
	assert.equal(found[0].message, 'Duplicate key "dup"');
});

test('non-breaking space in the message structure is flagged at that character', () => {
	const doc = wrap('pick: "{g,\u00a0select, other {x}}"');
	const found = run(doc);
	assert.deepEqual(found, [['nbsp', 'error', '\u00a0']]);
});

test('non-breaking space with unbalanced braces reports both problems', () => {
	const doc = wrap('pick: "{g,\u00a0select, other {x}"');
	assert.deepEqual(run(doc).map(d => d[0]).sort(), ['nbsp', 'parse']);
});

test('an entry whose text also appears inside an earlier multi-line value gets its own range', () => {
	// Entry `b` is textually contained in the backtick value of `a`; a plain indexOf would find it there.
	const doc = 'export default {\n\ta: `x\n\tb: "{y",\n`,\n\tb: "{y",\n};\n';
	const found = analyze(doc, 'en.mf.js');
	assert.equal(found.length, 2);
	assert.equal(found[1].start, doc.lastIndexOf('{y'));
	assert.ok(found[0].start < doc.indexOf('`,'), 'first diagnostic belongs to a');
});

test('non-breaking space in plain text is fine', () => {
	assert.deepEqual(run(wrap('text: "a\u00a0b"')), []);
});

test('entries after an identical earlier entry still get correct ranges', () => {
	const doc = wrap('a: "{x"', 'b: "ok"', 'c: "{x"');
	const found = analyze(doc, 'en.mf.js');
	assert.equal(found.length, 1 + 1); // a and c; b is clean
	assert.deepEqual(found.map(d => d.start), [doc.indexOf('{x'), doc.lastIndexOf('{x')]);
});

test('quoted keys, single quotes and trailing comments are handled', () => {
	const doc = "export default {\n\t\"quoted.key\": '{n, plural, one {x}}', // mfv-translated\n};\n";
	assert.deepEqual(run(doc), [['other', 'error', '{n, plural, one {x}}']]);
});

test('an empty or non-resource document yields nothing and does not throw', () => {
	assert.deepEqual(run(''), []);
	assert.deepEqual(run('export default {};\n'), []);
	assert.deepEqual(run('just some prose\n'), []);
});

test('diagnostics are sorted by position', () => {
	const doc = wrap('a: "{x"', 'b: "{g, select, male {x}}"', 'a: "dup"');
	const starts = analyze(doc, 'en.mf.js').map(d => d.start);
	assert.deepEqual(starts, [...starts].sort((x, y) => x - y));
});

test('localeFromFileName', () => {
	assert.equal(localeFromFileName('/a/b/fr-ca.mf.js'), 'fr-ca');
	assert.equal(localeFromFileName('file:///a/b/en.mf'), 'en');
	assert.equal(localeFromFileName('C:\\a\\de.mf.js'), 'de');
	// Not locales: fall back instead of silently using the runtime default
	assert.equal(localeFromFileName('messages.mf.js'), 'en');
	assert.equal(localeFromFileName('sample.mf'), 'en');
	assert.equal(localeFromFileName('messages.mf.js', 'fr'), 'fr');
	assert.equal(localeFromFileName(''), 'en');
});

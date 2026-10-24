import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { findConfig, localeOf, resolveSource } from '../src/source.js';

const root = mkdtempSync(join(tmpdir(), 'mf-source-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** Creates `files` (relative path -> contents) under a fresh directory and returns it. */
let n = 0;
function project(files) {
	const dir = join(root, `p${n++}`);
	for (const [name, contents] of Object.entries(files)) {
		mkdirSync(join(dir, name, '..'), { recursive: true });
		writeFileSync(join(dir, name), contents);
	}
	return dir;
}

const resolve = (dir, file) => resolveSource(join(dir, file));
const summary = r => r && { locale: r.locale, file: r.path.slice(r.path.lastIndexOf('/') + 1) };

test('localeOf takes the name before the first dot, lowercased', () => {
	assert.equal(localeOf('/a/fr-CA.mf.js'), 'fr-ca');
	assert.equal(localeOf('en.js'), 'en');
	assert.equal(localeOf('/a/b/pt.messages'), 'pt');
});

test('defaults to en when no config exists', () => {
	const dir = project({ 'en.mf.js': '', 'fr.mf.js': '' });
	assert.deepEqual(summary(resolve(dir, 'fr.mf.js')), { locale: 'en', file: 'en.mf.js' });
});

test('defaults to en-us when there is no en', () => {
	const dir = project({ 'en-us.mf.js': '', 'fr.mf.js': '' });
	assert.deepEqual(summary(resolve(dir, 'fr.mf.js')), { locale: 'en-us', file: 'en-us.mf.js' });
});

test('en wins over en-us when both exist', () => {
	const dir = project({ 'en.mf.js': '', 'en-us.mf.js': '', 'fr.mf.js': '' });
	assert.equal(resolve(dir, 'fr.mf.js').locale, 'en');
});

test('no source when neither default exists', () => {
	const dir = project({ 'fr.mf.js': '', 'de.mf.js': '' });
	assert.equal(resolve(dir, 'fr.mf.js'), undefined);
});

test('the source file itself has no source to compare against', () => {
	const dir = project({ 'en.mf.js': '', 'fr.mf.js': '' });
	assert.equal(resolve(dir, 'en.mf.js'), undefined);
});

test('mfv.config.json source is used, found in a parent directory', () => {
	const dir = project({
		'mfv.config.json': JSON.stringify({ source: 'de' }),
		'lang/de.mf.js': '',
		'lang/en.mf.js': '',
		'lang/fr.mf.js': '',
	});
	assert.deepEqual(summary(resolve(join(dir, 'lang'), 'fr.mf.js')), { locale: 'de', file: 'de.mf.js' });
});

test('a configured source that does not exist does not fall back to en', () => {
	const dir = project({ 'mfv.config.json': JSON.stringify({ source: 'de' }), 'en.mf.js': '', 'fr.mf.js': '' });
	assert.equal(resolve(dir, 'fr.mf.js'), undefined);
});

test('a config without "source" still defaults to en', () => {
	const dir = project({ 'mfv.config.json': JSON.stringify({ path: 'lang/' }), 'en.mf.js': '', 'fr.mf.js': '' });
	assert.equal(resolve(dir, 'fr.mf.js').locale, 'en');
});

test('the nearest config wins', () => {
	const dir = project({
		'mfv.config.json': JSON.stringify({ source: 'de' }),
		'sub/mfv.config.json': JSON.stringify({ source: 'en' }),
		'sub/de.mf.js': '',
		'sub/en.mf.js': '',
		'sub/fr.mf.js': '',
	});
	assert.equal(resolve(join(dir, 'sub'), 'fr.mf.js').locale, 'en');
});

test('locales outside the config "locales" list are not compared', () => {
	const dir = project({
		'mfv.config.json': JSON.stringify({ source: 'en', locales: ['fr'] }),
		'en.mf.js': '', 'fr.mf.js': '', 'de.mf.js': '',
	});
	assert.equal(resolve(dir, 'fr.mf.js').locale, 'en');
	assert.equal(resolve(dir, 'de.mf.js'), undefined);
});

test('an invalid config is reported and the defaults still apply', () => {
	const dir = project({ 'mfv.config.json': '{ nope', 'en.mf.js': '', 'fr.mf.js': '' });
	const found = resolve(dir, 'fr.mf.js');
	assert.equal(found.locale, 'en');
	assert.match(found.configError, /JSON|property|Expected/i);
	assert.ok(findConfig(dir).error);
});

test('the source file with the same extension as the target is preferred', () => {
	const dir = project({ 'en.js': '', 'en.mf.js': '', 'fr.mf.js': '' });
	assert.equal(summary(resolve(dir, 'fr.mf.js')).file, 'en.mf.js');
	const legacy = project({ 'en.js': '', 'en.mf.js': '', 'fr.js': '' });
	assert.equal(summary(resolve(legacy, 'fr.js')).file, 'en.js');
});

test('locale matching is exact and dotfiles never match', () => {
	const dir = project({ '.en.mf.js': '', 'enx.mf.js': '', 'fr.mf.js': '' });
	assert.equal(resolve(dir, 'fr.mf.js'), undefined);
});

test('a missing directory does not throw', () => {
	assert.equal(resolveSource(join(root, 'nope', 'fr.mf.js')), undefined);
});

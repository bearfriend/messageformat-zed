#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	createConnection,
	DiagnosticSeverity,
	ProposedFeatures,
	TextDocuments,
	TextDocumentSyncKind,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze, DEFAULT_LOCALE } from './src/analyze.js';
import { resolveSource } from './src/source.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let defaultLocale = DEFAULT_LOCALE;

// Set MESSAGEFORMAT_LS_LOG=/path/to/file to also write a trace to a file (handy when the editor hides stderr).
const logFile = process.env.MESSAGEFORMAT_LS_LOG;
function log(message) {
	if (logFile) {
		try {
			appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
		}
		catch {
			// Logging must never break the server.
		}
	}
	try {
		connection.console.info(message);
	}
	catch {
		// Not attached to a client yet.
	}
}

log(`starting: pid=${process.pid} argv=${JSON.stringify(process.argv.slice(2))} cwd=${process.cwd()}`);
process.on('uncaughtException', error => log(`uncaughtException: ${error?.stack ?? error}`));
process.on('unhandledRejection', error => log(`unhandledRejection: ${error?.stack ?? error}`));

connection.onInitialize(({ initializationOptions, clientInfo, rootUri }) => {
	log(`initialize: client=${clientInfo?.name ?? '?'} root=${rootUri ?? '-'} node=${process.version}`);
	if (typeof initializationOptions?.defaultLocale === 'string') {
		defaultLocale = initializationOptions.defaultLocale;
	}
	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
		},
		serverInfo: { name: 'messageformat-language-server' },
	};
});

const SEVERITY = {
	error: DiagnosticSeverity.Error,
	warning: DiagnosticSeverity.Warning,
};

const filePathOf = (uri) => {
	if (!uri.startsWith('file:')) return undefined;
	try {
		return fileURLToPath(uri);
	}
	catch {
		return undefined;
	}
};

/** The source-locale file for a document: its open buffer if it has one, otherwise the file on disk. */
function loadSource(document) {
	const path = filePathOf(document.uri);
	if (!path) return undefined;
	const resolved = resolveSource(path);
	if (!resolved) return undefined;
	if (resolved.configError) log(`ignoring ${resolved.configPath}: ${resolved.configError}`);
	const open = documents.all().find(d => filePathOf(d.uri) === resolved.path);
	try {
		return { locale: resolved.locale, path: resolved.path, contents: open ? open.getText() : readFileSync(resolved.path, 'utf8') };
	}
	catch (error) {
		log(`cannot read source ${resolved.path}: ${error.message}`);
		return undefined;
	}
}

// source file path -> uris of the open documents that were last compared against it
const dependents = new Map();

function validate(document) {
	let found;
	try {
		const source = loadSource(document);
		for (const uris of dependents.values()) uris.delete(document.uri);
		if (source) {
			if (!dependents.has(source.path)) dependents.set(source.path, new Set());
			dependents.get(source.path).add(document.uri);
		}
		found = analyze(document.getText(), document.uri, { defaultLocale, source });
		log(`validated ${document.uri} (languageId=${document.languageId}, v${document.version}, source=${source ? source.locale : 'none'}): ${found.length} diagnostic(s)`);
	}
	catch (error) {
		connection.console.error(`Failed to analyze ${document.uri}: ${error?.stack ?? error}`);
		found = [];
	}
	connection.sendDiagnostics({
		uri: document.uri,
		version: document.version,
		diagnostics: found.map(d => ({
			range: { start: document.positionAt(d.start), end: document.positionAt(d.end) },
			severity: SEVERITY[d.severity],
			code: d.code,
			source: 'messageformat',
			message: d.message,
		})),
	});
}

const timers = new Map();
function schedule(document) {
	clearTimeout(timers.get(document.uri));
	timers.set(document.uri, setTimeout(() => {
		timers.delete(document.uri);
		validate(document);
	}, 150));
}

documents.onDidOpen(({ document }) => {
	log(`opened ${document.uri} (languageId=${document.languageId}, ${document.getText().length} chars)`);
});

documents.onDidChangeContent(({ document }) => {
	schedule(document);
	// Editing a source file changes what every translation open next to it is compared against.
	const path = filePathOf(document.uri);
	for (const uri of dependents.get(path) ?? []) {
		const dependent = documents.get(uri);
		if (dependent && uri !== document.uri) schedule(dependent);
	}
});

documents.onDidClose(({ document }) => {
	clearTimeout(timers.get(document.uri));
	timers.delete(document.uri);
	for (const uris of dependents.values()) uris.delete(document.uri);
	connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
});

documents.listen(connection);
connection.listen();

#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import {
	createConnection,
	DiagnosticSeverity,
	ProposedFeatures,
	TextDocuments,
	TextDocumentSyncKind,
} from 'vscode-languageserver/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze, DEFAULT_LOCALE } from './src/analyze.js';

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

function validate(document) {
	let found;
	try {
		found = analyze(document.getText(), document.uri, { defaultLocale });
	}
	catch (error) {
		connection.console.error(`Failed to analyze ${document.uri}: ${error?.stack ?? error}`);
		found = [];
	}
	log(`validated ${document.uri} (languageId=${document.languageId}, v${document.version}): ${found.length} diagnostic(s)`);
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

documents.onDidOpen(({ document }) => {
	log(`opened ${document.uri} (languageId=${document.languageId}, ${document.getText().length} chars)`);
});

const timers = new Map();
documents.onDidChangeContent(({ document }) => {
	clearTimeout(timers.get(document.uri));
	timers.set(document.uri, setTimeout(() => {
		timers.delete(document.uri);
		validate(document);
	}, 150));
});

documents.onDidClose(({ document }) => {
	clearTimeout(timers.get(document.uri));
	timers.delete(document.uri);
	connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
});

documents.listen(connection);
connection.listen();

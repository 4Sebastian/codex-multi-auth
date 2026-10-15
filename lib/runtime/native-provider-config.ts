import { tomlStringLiteral } from "./config-toml.js";

import {
	NATIVE_PROVIDER_BEGIN as BEGIN,
	hasNativeProviderConfig,
} from "../runtime-constants.js";
export { hasNativeProviderConfig } from "../runtime-constants.js";
const END = "# codex-multi-auth native provider end";
const ROOT_KEYS = /^\s*(model_provider|openai_base_url)\s*=/;
function withoutNativeBlock(content: string): string {
	const start = content.indexOf(BEGIN);
	if (start < 0) return content;
	const end = content.indexOf(END, start);
	if (end < 0) throw new Error("Incomplete native provider binding");
	return (
		content.slice(0, start) +
		content.slice(end + END.length).replace(/^\r?\n/, "")
	);
}
function rootLines(content: string, select: boolean): string[] {
	let root = true;
	return content.split(/\r?\n/).filter((line) => {
		if (/^\s*\[/.test(line)) root = false;
		const match = root && ROOT_KEYS.test(line);
		return select ? match : !match;
	});
}
export function rewriteNativeProviderConfig(
	content: string,
	baseUrl: string,
): string {
	const url = new URL(baseUrl);
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "[::1]"].includes(url.hostname) ||
		!url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error("Native provider requires a loopback proxy origin");
	const lines = rootLines(withoutNativeBlock(content), false);
	return [
		BEGIN,
		'model_provider = "openai"',
		`openai_base_url = ${tomlStringLiteral(baseUrl)}`,
		END,
		...lines,
	].join("\n");
}
export function restoreNativeProviderConfig(
	content: string,
	original: string,
): string {
	if (!hasNativeProviderConfig(content)) return content;
	return [
		...rootLines(original, true),
		...rootLines(withoutNativeBlock(content), false),
	].join("\n");
}

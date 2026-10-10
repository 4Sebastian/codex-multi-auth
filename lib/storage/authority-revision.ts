import { statSync } from "node:fs";

export function captureAuthorityRevision(paths: string[]): () => boolean {
	const sample = () => paths.map(path => {
		try {
			const info = statSync(path, { bigint: true });
			return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
		} catch (error) {
			if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
			throw error;
		}
	}).join("|");
	const revision = sample();
	return () => revision === sample();
}

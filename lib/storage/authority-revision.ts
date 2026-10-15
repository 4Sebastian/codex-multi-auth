import { statSync } from "node:fs";

export function captureAuthorityRevision(paths: string[], absentPaths: string[] = []): () => boolean {
	const sample = () => {
		for (const path of absentPaths) {
			try { statSync(path); return undefined; }
			catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return undefined;
			}
		}
		return paths.map(path => {
			try {
				const info = statSync(path, { bigint: true });
				return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
			} catch (error) {
				if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
				throw error;
			}
		}).join("|");
	};
	const revision = sample();
	return () => revision !== undefined && revision === sample();
}

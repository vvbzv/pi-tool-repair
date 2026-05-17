import type { RepairRecord } from "./records";

function removeAt(input: string, offset: number, count: number): string {
	return input.slice(0, offset) + input.slice(offset + count);
}

function closeUnclosedJson(input: string): string | undefined {
	const trimmed = input.trimStart();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;

	const stack: string[] = [];
	let inString = false;
	let escaped = false;

	for (const ch of input) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") stack.push("}");
		else if (ch === "[") stack.push("]");
		else if (ch === "}" || ch === "]") {
			if (stack[stack.length - 1] !== ch) return undefined;
			stack.pop();
		}
	}

	if (inString || stack.length === 0 || stack.length > 3) return undefined;
	return input + stack.reverse().join("");
}

function syntaxOffset(error: unknown): number | undefined {
	if (!(error instanceof SyntaxError)) return undefined;
	const match = /position (\d+)/.exec(error.message);
	if (!match) return undefined;
	const offset = Number(match[1]);
	return Number.isInteger(offset) ? offset : undefined;
}

function rawRecord(detail: string): RepairRecord {
	return { type: "close-braces", path: "$", stage: "raw-json", detail };
}

export function repairRawJsonObject(raw: string): { raw: string; repaired: boolean; records: RepairRecord[] } {
	let current = raw;
	const records: RepairRecord[] = [];

	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			JSON.parse(current);
			return { raw: current, repaired: current !== raw, records };
		} catch (error) {
			const offset = syntaxOffset(error);
			if (offset === undefined || offset < 0 || offset >= current.length) break;

			const ch = current[offset];
			if (ch === "}" || ch === "]") {
				current = removeAt(current, offset, 1);
				records.push(rawRecord(`removed ${ch}`));
				continue;
			}

			if (ch === "\\") {
				const next = current[offset + 1];
				const count = next === "n" || next === "t" || next === "r" ? 2 : 1;
				current = removeAt(current, offset, count);
				records.push(rawRecord("removed stray escape"));
				continue;
			}

			break;
		}
	}

	const closed = closeUnclosedJson(current);
	if (closed !== undefined) {
		try {
			JSON.parse(closed);
			records.push(rawRecord("appended closers"));
			return { raw: closed, repaired: true, records };
		} catch {
			return { raw, repaired: false, records: [] };
		}
	}

	return { raw, repaired: false, records: [] };
}

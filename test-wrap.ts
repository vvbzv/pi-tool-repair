import { Type } from "typebox";
import { withToolRepair } from "./src/wrap";

function check(name: string, actual: unknown, expected: unknown): boolean {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	console.log(ok ? `  ✓ ${name}` : `  ✗ ${name}`);
	if (!ok) {
		console.log(`expected: ${JSON.stringify(expected)}`);
		console.log(`got:      ${JSON.stringify(actual)}`);
	}
	return ok;
}

const schema = Type.Object({
	path: Type.String(),
	limit: Type.Optional(Type.Number()),
	paths: Type.Optional(Type.Array(Type.String())),
});

const tool = withToolRepair({
	name: "example",
	label: "example",
	description: "Example tool",
	parameters: schema,
	async execute() {
		return { content: [{ type: "text", text: "ok" }], details: {} };
	},
});

const prepared = tool.prepareArguments?.({
	path: "x.ts",
	limit: "12",
	paths: '["a.ts","b.ts"]',
});

const expected = { path: "x.ts", limit: 12, paths: ["a.ts", "b.ts"] };

let ok = check("wrapper repairs before validation", prepared, expected);

let prepareCalls = 0;
const wrappedExistingPrepare = withToolRepair({
	name: "example-existing",
	label: "example-existing",
	description: "Example tool with existing prepareArguments",
	parameters: schema,
	prepareArguments(args: unknown) {
		prepareCalls++;
		const record = args as { path: string; limit?: string; paths?: string[] };
		return {
			path: record.path,
			limit: record.limit,
			paths: record.paths ? JSON.stringify(record.paths) : undefined,
		};
	},
	async execute() {
		return { content: [{ type: "text", text: "ok" }], details: {} };
	},
});

const preparedExisting = wrappedExistingPrepare.prepareArguments?.({
	path: "y.ts",
	limit: "3",
	paths: ["c.ts", "d.ts"],
});

ok = check(
	"wrapper preserves existing prepareArguments before repair",
	preparedExisting,
	{ path: "y.ts", limit: 3, paths: ["c.ts", "d.ts"] },
) && ok;
ok = check("existing prepareArguments called once", prepareCalls, 1) && ok;

process.exit(ok ? 0 : 1);

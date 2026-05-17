import { repairRawJsonObject } from "./src/raw-json";

let passed = 0;
let failed = 0;

function test(name: string, input: string, expected: string, repaired: boolean) {
	const actual = repairRawJsonObject(input);
	const ok = actual.raw === expected && actual.repaired === repaired;
	console.log(ok ? `  ✓ ${name}` : `  ✗ ${name}`);
	if (!ok) {
		console.log(`expected: ${expected}`);
		console.log(`got:      ${actual.raw}`);
		console.log(`expected repaired: ${repaired}, got: ${actual.repaired}`);
		failed++;
	} else {
		passed++;
	}
}

test(
	"repairs Docker extra closing brace",
	'{"path":"ci.yml","edits":[{"oldText":"old","newText":"new"}}]}',
	'{"path":"ci.yml","edits":[{"oldText":"old","newText":"new"}]}',
	true,
);

test(
	"repairs Docker extra closing bracket",
	'{"path":"build.sh","edits":[{"oldText":"a","newText":"b"}]]}',
	'{"path":"build.sh","edits":[{"oldText":"a","newText":"b"}]}',
	true,
);

test(
	"repairs missing closing delimiters",
	'{"payload":{"items":[1,2',
	'{"payload":{"items":[1,2]}}',
	true,
);

test(
	"leaves unrepairable garbage unchanged",
	'{totally broken <<<>>>',
	'{totally broken <<<>>>',
	false,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

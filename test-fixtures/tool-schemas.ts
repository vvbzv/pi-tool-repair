export const readSchema = {
	type: "object",
	required: ["path"],
	properties: {
		path: { type: "string" },
		offset: { type: "number" },
		limit: { type: "number" },
	},
};

export const editSchema = {
	type: "object",
	required: ["path", "edits"],
	properties: {
		path: { type: "string" },
		edits: {
			type: "array",
			items: {
				type: "object",
				required: ["oldText", "newText"],
				properties: {
					oldText: { type: "string" },
					newText: { type: "string" },
				},
			},
		},
	},
};

export const multiEditSchema = {
	type: "object",
	required: [],
	properties: {
		path: { type: "string" },
		oldText: { type: "string" },
		newText: { type: "string" },
		patch: { type: "string" },
		multi: {
			type: "array",
			items: {
				type: "object",
				required: ["oldText", "newText"],
				properties: {
					path: { type: "string" },
					oldText: { type: "string" },
					newText: { type: "string" },
				},
			},
		},
	},
};

export const leanCtxShellSchema = {
	type: "object",
	required: ["command"],
	properties: {
		command: { type: "string" },
		description: { type: "string" },
	},
};

export const mcpGatewaySchema = {
	type: "object",
	required: ["server", "tool", "args"],
	properties: {
		server: { type: "string" },
		tool: { type: "string" },
		args: { type: "object", properties: {}, required: [] },
	},
};

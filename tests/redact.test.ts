import { describe, expect, test } from "bun:test";

import { pickSafeEvent, redactSecrets } from "../src/core/redact";

describe("redactSecrets", () => {
	test("scrubs a Bearer token", () => {
		expect(redactSecrets("failed: 401 Authorization: Bearer sk-abc123def456ghi789jkl")).not.toMatch(/sk-abc123def456ghi789jkl/);
		expect(redactSecrets("Bearer sk-abc123def456ghi789jkl")).toContain("[REDACTED]");
	});

	test("scrubs sk- / github_pat_ / AKIA access keys", () => {
		expect(redactSecrets("key=sk-ABCDEFGHIJKLMNOPQRSTUVWXYZab")).not.toContain("ABCDEFGHIJKLMNOPQRS");
		expect(redactSecrets("token=github_pat_1234567890abcdef")).not.toContain("github_pat_");
		expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).not.toContain("AKIAIOSFODNN7");
	});

	test("scrubs JWT-shaped tokens", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
		expect(redactSecrets(`auth=${jwt}`)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
	});

	test("scrubs PEM private-key and certificate blocks", () => {
		const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA123456\n-----END RSA PRIVATE KEY-----";
		expect(redactSecrets(pem)).not.toContain("PRIVATE KEY");
		const cert = "-----BEGIN CERTIFICATE-----\nMIIC8jCCAdqgAwIBAgIQ\n-----END CERTIFICATE-----";
		expect(redactSecrets(cert)).not.toContain("MIIC8jCCAdqg");
	});

	test("scrubs credentials embedded in a URL", () => {
		expect(redactSecrets("https://user:sekret@api.example.com/v1")).not.toMatch(/user:sekret@/);
		expect(redactSecrets("https://api.example.com/v1?api_key=sekret&x=1")).not.toContain("sekret");
	});

	test("scrubs labeled api key / secret / password assignments", () => {
		expect(redactSecrets("export API_KEY=my-super-secret-value-123")).not.toContain("my-super-secret-value");
		expect(redactSecrets('client_secret: "shhh-secret-value-456789"')).not.toContain("shhh-secret-value");
	});

	test("never throws and returns benign text unchanged", () => {
		expect(redactSecrets("plain error message")).toBe("plain error message");
		expect(redactSecrets("")).toBe("");
	});

	test("scrubs compound labels with underscore prefixes (aws_secret_access_key)", () => {
		const aws = "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
		expect(redactSecrets(aws)).not.toContain("wJalrXUtnFEMI");
		expect(redactSecrets("db_password=Sup3rSecretLongPwd")).not.toContain("Sup3rSecretLongPwd");
	});

	test("scrubs LLM/cloud provider key prefixes", () => {
		expect(redactSecrets("gsk_AbCdEfGhIjKlMnOpQrStUvWxYz")).not.toContain("AbCdEfGhIjKlMnOp");
		expect(redactSecrets("pplx-abcdef0123456789abcdef")).not.toContain("abcdef0123456789");
		expect(redactSecrets("xai-abcdef0123456789abcdef")).not.toContain("abcdef0123456789");
		expect(redactSecrets("hf_abcdef0123456789abcdef")).not.toContain("abcdef0123456789");
		expect(redactSecrets("glpat-abcdef0123456789ab")).not.toContain("abcdef0123456789");
		expect(redactSecrets("gho_abcdef0123456789abcdef")).not.toContain("abcdef0123456789");
		expect(redactSecrets("SG.abcdef0123456789abcdef.abcdef0123456789abcdef0123456789abcdef0")).not.toContain("abcdef0123456789");
	});

	test("scrubs credentials in non-HTTP URL schemes", () => {
		expect(redactSecrets("postgres://admin:hunter2secret@db.internal:5432/app")).not.toContain("hunter2secret");
		expect(redactSecrets("redis://:longredispassword@cache:6379")).not.toContain("longredispassword");
		expect(redactSecrets("mongodb+srv://u:mongopassword@cluster/x")).not.toContain("mongopassword");
	});

	test("scrubs labeled secrets with shell-special characters", () => {
		expect(redactSecrets('password: "p@ss!word-2024xyz"')).not.toContain("p@ss!word");
		expect(redactSecrets("password=abc!defghijklmn")).not.toContain("defghijklmn");
	});

	test("scrubs Authorization Basic credentials", () => {
		expect(redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA")).not.toContain("dXNlcjpwYXNzd29yZA");
	});

	test("scrubs AWS presigned-URL and session query parameters", () => {
		const url = "https://s3.example.com/b/k?X-Amz-Signature=abc123def456&X-Amz-Credential=AKIAEXAMPLE%2F20240101&session=sessiontoken123";
		const out = redactSecrets(url);
		expect(out).not.toContain("abc123def456");
		expect(out).not.toContain("sessiontoken123");
		expect(out).not.toContain("AKIAEXAMPLE");
	});

	test("scrubs truncated PEM blocks", () => {
		const truncated = "error: -----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdef\nMIIEowIBAAKCAQEA1234567890abcdef";
		expect(redactSecrets(truncated)).not.toContain("MIIEowIBAAKCAQEA");
	});
});

describe("pickSafeEvent", () => {
	test("keeps only whitelisted scalar fields, dropping nested objects and unknown keys", () => {
		const event = {
			provider: "anthropic",
			model: "claude",
			attempt: 2,
			reason: "overloaded",
			nested: { apiKey: "sk-leak" },
			request: "sensitive request body",
		};
		const picked = pickSafeEvent(event, ["provider", "model", "attempt", "reason"]);
		expect(picked).toEqual({ provider: "anthropic", model: "claude", attempt: 2, reason: "overloaded" });
	});

	test("redacts string values it keeps", () => {
		const picked = pickSafeEvent({ provider: "Bearer sk-ABCDEFGHIJ0123456789" }, ["provider"]);
		expect(picked.provider).not.toContain("ABCDEFGHIJ0123456789");
	});

	test("keeps arrays of scalars, redacting string elements", () => {
		const picked = pickSafeEvent({ models: ["a", "Bearer sk-xyz0987654321"] }, ["models"]);
		expect(picked.models).toHaveLength(2);
		expect((picked.models as unknown[])[1]).not.toContain("sk-xyz0987654321");
	});

	test("drops arrays of objects entirely", () => {
		const picked = pickSafeEvent({ list: [{ apiKey: "sk-x" }] }, ["list"]);
		expect(picked.list).toBeUndefined();
	});

	test("malformed input yields an empty object, never throws", () => {
		expect(pickSafeEvent(null, ["a"])).toEqual({});
		expect(pickSafeEvent("str", ["a"])).toEqual({});
		expect(pickSafeEvent([1, 2], ["a"])).toEqual({});
		expect(pickSafeEvent(undefined, ["a"])).toEqual({});
	});
});

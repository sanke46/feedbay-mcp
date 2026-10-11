/**
 * End-to-end smoke test against a running FeedBay backend.
 *
 * Drives the server through a real MCP client over an in-memory transport, so
 * what is exercised is the actual protocol surface — tool schemas, argument
 * validation, result shapes — not the handler functions in isolation.
 *
 *   NO_PROXY='*' FEEDBAY_API_URL=http://localhost:8080 \
 *   FEEDBAY_API_KEY=fb_live_... npm run smoke -w @feedbay/mcp-server
 *
 * It creates a survey, publishes it, answers it, reads the results and then
 * deletes everything it made.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FeedBayClient } from "../src/client/endpoints.js";
import { loadConfig } from "../src/config.js";
import { createServer, tokenSourceFor } from "../src/server.js";

const config = loadConfig();
let failures = 0;
let step = 0;

function check(label: string, condition: boolean, detail?: string): void {
  step += 1;
  if (condition) {
    console.log(`  ok  ${String(step).padStart(2, " ")}. ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${String(step).padStart(2, " ")}. ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

async function main(): Promise<void> {
  console.log(`FeedBay MCP smoke test against ${config.apiUrl} (${config.credentials.kind})\n`);

  await ensureAccountExists();

  const { server, toolCount } = createServer(
    config,
    tokenSourceFor(config.credentials, config.apiUrl, config.requestTimeoutMs),
  );
  const client = new Client({ name: "smoke", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  /** Call a tool and fail loudly if the server reported an error. */
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const result = (await client.callTool({ name, arguments: args })) as ToolResult;
    const text = result.content.map((part) => part.text ?? `<${part.type}>`).join("\n");
    if (result.isError) throw new Error(`${name} failed: ${text}`);
    return text;
  };

  const { tools } = await client.listTools();
  check(`lists ${toolCount} tools`, tools.length === toolCount, `saw ${tools.length}`);
  check(
    "every tool carries a description and an annotated safety hint",
    tools.every((tool) => tool.description && tool.annotations?.readOnlyHint !== undefined),
  );

  const whoami = await call("feedbay_whoami");
  check("feedbay_whoami reports the signed-in account", whoami.includes("Signed in as"), whoami.slice(0, 200));

  const types = await call("feedbay_question_types");
  check("question type catalogue is served", types.includes("RATING_SCALE") && types.includes("configFields"));

  // ---- build a survey from a template plus one hand-written question --------
  const created = await call("survey_create", {
    name: `MCP smoke ${new Date().toISOString().slice(0, 19)}`,
    channel: "WEBSITE",
    displayMode: "POPUP_CENTER",
    fromTemplate: "nps",
    questions: [{ type: "single_choice", title: "Which plan are you on?", config: { options: ["Free", "Paid"] } }],
  });
  const surveyId = JSON.parse(created.slice(created.indexOf("{"))).id as string;
  check("survey_create seeds questions from a template and appends our own", /"questionCount": 3/.test(created), created.slice(0, 300));

  const added = await call("question_add", {
    surveyId,
    type: "long_text",
    title: "Anything else we should know?",
    position: 2,
  });
  const questionId = JSON.parse(added.slice(added.indexOf("{"))).added as string;
  check("question_add inserts at the requested position", added.includes('"order": 2'));

  const updated = await call("question_update", { surveyId, questionId, config: { placeholder: "Type here" } });
  check("question_update merges config without wiping siblings", updated.includes("Type here"));

  const listed = await call("question_list", { surveyId });
  check("question_list returns four questions in order", (listed.match(/"order":/g) ?? []).length === 4, listed.slice(0, 200));

  // ---- style, target, publish ----------------------------------------------
  const styled = await call("design_apply_preset", { surveyId, preset: "brand", brandColor: "#7C3AED", mode: "light" });
  check("design_apply_preset writes a brand palette", styled.includes('"buttonColor": "#7C3AED"'), styled.slice(0, 300));
  check("design_apply_preset reports its contrast checks", styled.includes("contrastReport"));

  const targeted = await call("targeting_update", { surveyId, triggerType: "exit" });
  check("targeting_update sets a trigger the dashboard cannot", targeted.includes('"triggerType": "exit"'));

  const published = await call("survey_set_status", { surveyId, action: "publish" });
  check("survey_set_status publishes", published.includes("PUBLISHED"));

  const share = await call("survey_share_info", { surveyId });
  const publicId = JSON.parse(share.slice(share.indexOf("{"))).publicId as string;
  check("survey_share_info returns a public link and embed code", share.includes("publicUrl") && share.includes("embedCode"));

  // ---- answer it as a respondent, then read the data back ------------------
  const api = new FeedBayClient(
    config,
    tokenSourceFor(config.credentials, config.apiUrl, config.requestTimeoutMs),
  );
  const publicSurvey = await api.getSurvey(surveyId);
  const questionIds = ((publicSurvey.config as { questions?: Array<{ id: string }> }).questions ?? []).map((q) => q.id);
  await api.submitPublicResponse(publicId, {
    answers: Object.fromEntries(questionIds.map((id, index) => [id, index === 0 ? 9 : "smoke answer"])),
    completed: true,
    visitorId: "smoke-visitor",
    channel: "web",
  });
  check("a public response was accepted", true);

  const overview = await call("results_overview", { surveyId });
  check("results_overview counts the response", /"totalResponses": [1-9]/.test(overview), overview.slice(0, 200));

  const breakdown = await call("results_breakdown", { surveyId });
  check("results_breakdown splits by channel and day", breakdown.includes("byChannel") && breakdown.includes("byDay"));
  check("results_breakdown states whether it saw everything", breakdown.includes('"truncated": false'));

  const exported = await call("responses_export", { surveyId, format: "csv", outputPath: `${config.downloadDir}/mcp-smoke-export.csv` });
  check("responses_export returns CSV content", exported.includes("mcp-smoke-export.csv"), exported.slice(0, 200));

  const qr = (await client.callTool({ name: "survey_qr_code", arguments: { surveyId, size: 200 } })) as ToolResult;
  check("survey_qr_code returns a PNG image", qr.content.some((part) => part.type === "image"));

  // ---- resources ------------------------------------------------------------
  const resource = await client.readResource({ uri: `feedbay://survey/${surveyId}` });
  check("the survey resource is readable", String(resource.contents[0]?.text ?? "").includes(surveyId));

  // ---- the confirmation gate must actually hold ----------------------------
  const unconfirmed = await call("survey_delete_permanent", { surveyId });
  check("an irreversible tool refuses to run without confirm", unconfirmed.includes("confirm: true"));
  const stillThere = await call("survey_get", { surveyId });
  check("...and really did not delete anything", stillThere.includes(surveyId));

  // ---- clean up -------------------------------------------------------------
  await call("survey_set_status", { surveyId, action: "archive", confirm: true });
  await call("survey_delete_permanent", { surveyId, confirm: true });
  const gone = (await client.callTool({ name: "survey_get", arguments: { surveyId } })) as ToolResult;
  check("the survey is gone after a confirmed permanent delete", gone.isError === true);

  await client.close();
  await server.close();

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${step - failures}/${step} checks passed.`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * A local dev backend starts empty, so register the smoke account if it is not
 * there yet. Never against a remote host — creating accounts on a real
 * deployment is not this script's business.
 */
async function ensureAccountExists(): Promise<void> {
  // Ключ уже доказывает, что аккаунт есть: выпустить его мог только тот, кто в
  // него вошёл. Заводить здесь нечего, и лезть в /auth/register с ключом
  // бессмысленно — пароля у нас нет.
  if (config.credentials.kind === "apiKey") return;

  const { email, password } = config.credentials;
  const isLocal = /localhost|127\.0\.0\.1/.test(config.apiUrl);
  const response = await fetch(`${config.apiUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (response.ok) return;

  if (!isLocal) {
    throw new Error(`Cannot sign in as ${email} at ${config.apiUrl} — check FEEDBAY_EMAIL / FEEDBAY_PASSWORD.`);
  }

  console.log(`  ..  registering ${email} on the local backend`);
  const registered = await fetch(`${config.apiUrl}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fullName: "MCP Smoke", email, password }),
  });
  if (!registered.ok) {
    throw new Error(`Could not sign in or register ${email}: HTTP ${registered.status}`);
  }
}

main().catch((error: unknown) => {
  console.error(`\nsmoke test aborted: ${(error as Error).message}`);
  process.exit(1);
});

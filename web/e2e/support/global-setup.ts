/**
 * Fail fast when the stub on API runs another flavour than E2E_MODE —
 * e.g. an anonymous stub left running (webServer reuses it locally)
 * under an auth run.
 */
import { API, MODE } from "./env";

export default async function globalSetup(): Promise<void> {
  const r = await fetch(`${API}/_test/info`);
  if (!r.ok) throw new Error(`${API}/_test/info answered ${r.status}: is ${API} the stub backend?`);
  const info = (await r.json()) as { auth_test: boolean; r2: boolean };
  if (info.auth_test !== (MODE === "auth") || info.r2 !== (MODE === "r2")) {
    throw new Error(
      `The stub on ${API} runs auth_test=${info.auth_test} r2=${info.r2}, not E2E_MODE=${MODE}. ` +
        "Stop it (and the web server on the same run) or use other ports (E2E_STUB_PORT / E2E_WEB_PORT).",
    );
  }
}

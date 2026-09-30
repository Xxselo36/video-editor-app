"use client";
// The voice-command test (moved from app/app/page.tsx in UX4).
import { useEffect, useRef, useState } from "react";
import { Check, Circle, X } from "lucide-react";
import { IconMic } from "@/components/Icons";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { IconButton } from "@/components/ui/IconButton";
import { useLang, useT } from "@/i18n";
import type { MessageKey } from "@/i18n/messages/en";

// Single-screen onboarding: live mic test + command list on one modal.
// Cheat sheet and test collapsed into one screen so the user doesn't
// need to click through. On first open, we don't force mic permission —
// user clicks 'Start test' when ready. All processing local, no backend.
export function VoiceTestDialog({ onClose }: { onClose: () => void }) {
  return <VoiceCommandsTestStep onDone={onClose} />;
}

// Speech recognition locale for the UI language: the browser's own
// regional variant when it prefers one ("de-AT"), else a common default.
const SPEECH_LOCALE: Record<string, string> = {
  en: "en-US", de: "de-DE", es: "es-ES", fr: "fr-FR", pt: "pt-BR", it: "it-IT", tr: "tr-TR",
  pl: "pl-PL", nl: "nl-NL", ru: "ru-RU", ja: "ja-JP", ko: "ko-KR", id: "id-ID", hi: "hi-IN",
};
function speechLocale(lang: string): string {
  const preferred = typeof navigator !== "undefined" ? navigator.languages ?? [] : [];
  const regional = preferred.find((tag) => tag.toLowerCase().startsWith(`${lang}-`));
  return regional ?? SPEECH_LOCALE[lang] ?? "en-US";
}

// Live mic test. User grants the microphone, says commands, gets
// real-time feedback. Uses the browser's Web Speech API
// (webkitSpeechRecognition) — nothing goes to the CleoCuts backend; the
// browser's recognizer may send the audio to its maker (Google in
// Chrome, Apple in Safari), which app.voice.permissionHint says.
function VoiceCommandsTestStep({ onDone }: { onDone: () => void }) {
  const t = useT();
  const lang = useLang();
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<any>(null);
  // Set when the dialog closes: onend must not restart recognition then.
  const closedRef = useRef(false);
  const [permStatus, setPermStatus] = useState<
    "idle" | "requesting" | "granted" | "denied" | "unsupported"
  >("idle");
  const [transcript, setTranscript] = useState("");
  const [detected, setDetected] = useState<Record<string, number>>({});
  const [lastHitAt, setLastHitAt] = useState(0);

  // `phrase` is the spoken command itself — not translated.
  const targets: { id: string; phrase: string; descKey: MessageKey; color: string }[] = [
    { id: "start", phrase: "Cleo start", descKey: "app.voice.cmd.start", color: "#5A9FFF" },
    { id: "cut", phrase: "Cleo cut", descKey: "app.voice.cmd.cut", color: "#F26E6E" },
    { id: "keep", phrase: "Cleo keep", descKey: "app.voice.cmd.keep", color: "#4ECC77" },
    { id: "finish", phrase: "Cleo finish", descKey: "app.voice.cmd.finish", color: "#B979FF" },
    { id: "stop", phrase: "Cleo stop", descKey: "app.voice.cmd.stop", color: "#F5B54D" },
    { id: "go", phrase: "Cleo go", descKey: "app.voice.cmd.go", color: "#F5B54D" },
  ];

  // Match keywords + common mishears. \s* (not \s+) so 'cleokeep',
  // 'cleogo' etc. (Web Speech often concatenates fast speech) match
  // the same as 'cleo keep'.
  const matchers: Record<string, RegExp> = {
    start: /\b(cleo|clio|klio|kleo|cleyo|clear)\s*(start|starts|starte|istab|isab)\b/i,
    cut: /\b(cleo|clio|klio|kleo|cleyo|clear)\s*(cut|cuts|kot|kutt|schnitt)\b/i,
    keep: /\b(cleo|clio|klio|kleo|cleyo|clear)\s*(keep|kip|kiep|behalten)\b/i,
    finish: /\b(cleo|clio|klio|kleo|cleyo|clear)\s*(finish|finnisch|fenish|ende|fertig)\b/i,
    stop: /\b(cleo|clio|klio|kleo|cleyo|clear)\s*(stop|stopp|halt)\b/i,
    go: /\b(cleo|clio|klio|kleo|cleyo|clear)\s*(go|los|weiter)\b/i,
  };

  const startTest = async () => {
    setPermStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (closedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      // Web Speech API
      const SR =
        (typeof window !== "undefined" &&
          ((window as any).SpeechRecognition ||
            (window as any).webkitSpeechRecognition)) ||
        null;
      if (!SR) {
        setPermStatus("unsupported");
        return;
      }
      const recognition = new SR();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = speechLocale(lang);
      recognition.onresult = (event: any) => {
        let text = "";
        for (let i = 0; i < event.results.length; i++) {
          text += event.results[i][0].transcript + " ";
        }
        setTranscript(text.trim());
        const newDetected: Record<string, number> = {};
        for (const [id, re] of Object.entries(matchers)) {
          const matches = text.match(new RegExp(re, "gi"));
          if (matches) newDetected[id] = matches.length;
        }
        if (Object.keys(newDetected).length > 0) {
          setLastHitAt(Date.now());
        }
        setDetected(newDetected);
      };
      recognition.onerror = (event: any) => {
        if (event.error === "not-allowed") setPermStatus("denied");
      };
      recognition.onend = () => {
        // Auto-restart while the dialog is open (never after it closed).
        if (closedRef.current) return;
        try {
          recognition.start();
        } catch {
          // ignore
        }
      };
      recognition.start();
      recognitionRef.current = recognition;
      setPermStatus("granted");
    } catch {
      setPermStatus("denied");
    }
  };

  useEffect(() => {
    closedRef.current = false;
    return () => {
      closedRef.current = true;
      try {
        recognitionRef.current?.stop();
      } catch {
        // ignore
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const pulseActive = Date.now() - lastHitAt < 800;

  return (
    <Dialog
      onClose={onDone}
      labelledBy="voice-test-title"
      testId="dialog-voice-test"
      panelClassName="relative flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-2xl"
      panelStyle={{
        background: "var(--surface-0)",
        border: "1px solid var(--border)",
        boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
      }}
    >
        {/* Compact header — one line title, one line explanation */}
        <div
          className="flex items-center justify-between p-4"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <div className="flex-1">
            <div
              id="voice-test-title"
              className="text-base font-bold"
              style={{ color: "var(--text-strong)" }}
            >
              {t("app.voice.title")}
            </div>
            <div
              className="text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              {t("app.voice.subtitle")}
            </div>
          </div>
          <IconButton
            onClick={onDone}
            data-testid="dialog-close"
            label={t("app.voice.close")}
            className="ml-3 shrink-0 rounded-lg p-1.5 transition-colors hover:bg-[var(--surface-2)]"
            style={{ color: "var(--text-muted)" }}
          >
            <Icon icon={X} />
          </IconButton>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Mic status OR permission prompt */}
          <div
            className="relative overflow-hidden"
            style={{
              background: "var(--surface-1)",
              aspectRatio: "16 / 7",
              borderBottom: "1px solid var(--border)",
            }}
          >
            {permStatus === "granted" && (
              <div
                aria-hidden
                className="flex h-full w-full items-center justify-center"
                style={{ color: pulseActive ? "#4ECC77" : "var(--text-muted)" }}
              >
                <IconMic size={40} strokeWidth={2} />
              </div>
            )}
            {permStatus === "granted" && (
              <>
                <div
                  className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
                  style={{
                    background: "rgba(0,0,0,0.7)",
                    color: pulseActive ? "#4ECC77" : "#fff",
                    backdropFilter: "blur(4px)",
                  }}
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{
                      background: pulseActive ? "#4ECC77" : "#F26E6E",
                      boxShadow: pulseActive ? "0 0 8px #4ECC77" : "none",
                    }}
                  />
                  {pulseActive ? t("app.voice.heardYou") : t("app.voice.listening")}
                </div>
                {/* Live transcript strip */}
                {transcript && (
                  <div
                    className="absolute bottom-0 left-0 right-0 p-2 text-[10px]"
                    style={{
                      background: "rgba(0,0,0,0.65)",
                      color: "#fff",
                      backdropFilter: "blur(4px)",
                    }}
                  >
                    <span style={{ color: "#aaa" }}>{t("app.voice.heardPrefix")}</span>
                    {transcript.slice(-100)}
                  </div>
                )}
              </>
            )}
            {permStatus !== "granted" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4">
                {(permStatus === "idle" || permStatus === "requesting") && (
                  <>
                    <div
                      className="text-center text-xs"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {t("app.voice.permissionHint")}
                    </div>
                    <Button onClick={startTest} disabled={permStatus === "requesting"}>
                      {permStatus === "requesting" ? t("app.voice.requesting") : t("app.voice.start")}
                    </Button>
                  </>
                )}
                {permStatus === "denied" && (
                  <div className="text-center text-xs" style={{ color: "var(--warn)" }}>
                    {t("app.voice.denied")}
                  </div>
                )}
                {permStatus === "unsupported" && (
                  <div className="text-center text-xs" style={{ color: "var(--warn)" }}>
                    {t("app.voice.unsupported")}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Command list — always visible, doubles as cheat sheet.
              Single-column with phrase + one-line explanation so the
              user sees what each command DOES, not just its name. */}
          <div className="flex flex-col gap-1.5 p-3">
            {targets.map((cmd) => {
              const count = detected[cmd.id] || 0;
              const hit = count > 0;
              return (
                <div
                  key={cmd.id}
                  className="flex items-center gap-2.5 rounded-lg p-2 transition-all"
                  style={{
                    background: "var(--surface-1)",
                    border: `1px solid ${hit ? cmd.color : "var(--border)"}`,
                    boxShadow: hit ? `0 0 12px ${cmd.color}55` : "none",
                  }}
                >
                  <div
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition-all"
                    style={{
                      background: hit ? cmd.color : "var(--surface-2)",
                      color: hit ? "white" : "var(--text-muted)",
                    }}
                  >
                    <Icon icon={hit ? Check : Circle} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className="font-mono text-[12px] font-semibold leading-tight"
                      style={{ color: "var(--text-strong)" }}
                    >
                      {cmd.phrase}
                    </div>
                    <div
                      className="text-[10px] leading-tight"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {t(cmd.descKey)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div
          className="p-3"
          style={{ borderTop: "1px solid var(--border)" }}
        >
          <Button onClick={onDone} className="w-full">
            {t("app.voice.done")}
          </Button>
        </div>
    </Dialog>
  );
}

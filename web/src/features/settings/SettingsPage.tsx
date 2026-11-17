"use client";
/**
 * /app/settings: Einstellungen (PR3, plan D16). The app's language; with
 * accounts, the account (email, plan and minutes, "Konto & Abo", the
 * avatar menu); the voice test ("„Cleo cut“ ausprobieren"); the legal
 * pages; the beta note, or "Preise" once billing is on. No upload
 * defaults: Neues Video remembers the last choices by itself (PR1 D4).
 * Browsers off v2 have no shell and no such tab: /app.
 */
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, FileText, Globe, Mic, UserRound } from "lucide-react";
import { AppPage } from "@/components/AppPage";
import { PageTitle } from "@/components/PageTitle";
import { AvatarButton } from "@/components/auth/AccountMenu";
import { Icon } from "@/components/ui/Icon";
import { LANGS, setLang, useLang, useT, type Lang } from "@/i18n";
import { fmtMinutes, planName, useAuthState, useBillingConfig, useMe } from "@/lib/account";
import { AUTH_ENABLED } from "@/lib/auth";
import { useProjectsV2 } from "@/features/jobs/useProjectsV2";
import s from "./settings.module.css";

// The voice test (microphone, recognizer): loaded when it opens.
const VoiceTestDialog = dynamic(
  () => import("@/features/voice-test/VoiceTestDialog").then((m) => m.VoiceTestDialog),
  { ssr: false },
);

/** Seen once: the start screens of v1 don't offer it again. */
const VOICE_SEEN = "cleocuts.voiceOnboardingSeen.v1";

// The voice command in a label, with its quotes: in its own colour.
const COMMAND = /[„“"«]?Cleo cut[“”"»]?/;

function withCommand(text: string): ReactNode {
  const m = COMMAND.exec(text);
  if (!m) return text;
  return (
    <>
      {text.slice(0, m.index)}
      <span className={s.cmd}>{m[0]}</span>
      {text.slice(m.index + m[0].length)}
    </>
  );
}

function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className={s.group} aria-labelledby={id}>
      <h2 id={id} className={s.groupTitle}>
        {title}
      </h2>
      <div className={s.card}>{children}</div>
    </section>
  );
}

function Label({ name, sub }: { name: ReactNode; sub?: ReactNode }) {
  return (
    <span className={s.label}>
      <span className={s.name}>{name}</span>
      {sub && <span className={s.sub}>{sub}</span>}
    </span>
  );
}

function LanguageRow() {
  const t = useT();
  const lang = useLang();
  return (
    <label className={s.row}>
      <span className={s.tile} aria-hidden="true">
        <Icon icon={Globe} />
      </span>
      <Label name={t("app.settings.appLanguage")} />
      <span className={s.value} aria-hidden="true">
        {LANGS[lang]}
      </span>
      <Icon icon={ChevronRight} className={s.chev} />
      <select
        value={lang}
        onChange={(e) => setLang(e.target.value as Lang)}
        data-testid="language-switcher"
        className={s.select}
        aria-label={t("app.settings.appLanguage")}
      >
        {(Object.keys(LANGS) as Lang[]).map((l) => (
          <option key={l} value={l} lang={l}>
            {LANGS[l]}
          </option>
        ))}
      </select>
    </label>
  );
}

function AccountRows() {
  const t = useT();
  const lang = useLang();
  const auth = useAuthState();
  const { me } = useMe();
  const config = useBillingConfig();
  if (!auth.signedIn) return null;
  const email = auth.email ?? me?.user?.email ?? null;
  const minutes = me?.minutes ?? null;
  const billing = Boolean(me?.billing?.enabled);
  const plan = billing && me?.plan ? planName(me.plan, config) : null;
  const usage =
    billing && minutes
      ? t("app.account.usageOf", { used: fmtMinutes(minutes.used, lang), limit: fmtMinutes(minutes.limit, lang) })
      : null;
  return (
    <Group id="settings-account-h" title={t("app.account.title")}>
      <div className={s.row}>
        <span className={s.tile} aria-hidden="true">
          <Icon icon={UserRound} />
        </span>
        <Label
          name={email ?? t("app.account.title")}
          sub={[plan, usage].filter(Boolean).join(" · ") || undefined}
        />
        <AvatarButton />
      </div>
      <Link href="/app/account" className={s.row} data-testid="settings-account">
        <Label name={t("app.settings.manageAccount")} />
        <Icon icon={ChevronRight} className={s.chev} />
      </Link>
    </Group>
  );
}

export function SettingsPage() {
  const t = useT();
  const router = useRouter();
  const v2 = useProjectsV2();
  const [voice, setVoice] = useState(false);
  const billing = Boolean(useMe().me?.billing?.enabled);

  useEffect(() => {
    if (v2 === false) router.replace("/app");
  }, [v2, router]);

  const closeVoice = () => {
    setVoice(false);
    try {
      localStorage.setItem(VOICE_SEEN, "1");
    } catch {
      // ignore
    }
  };

  const title = t("app.nav.settings");
  return (
    <AppPage width="2xl">
      <div className={s.page} data-testid="settings">
        <PageTitle bar={title}>{title}</PageTitle>

        <div className={s.card}>
          <LanguageRow />
        </div>

        {AUTH_ENABLED && <AccountRows />}

        <Group id="settings-voice-h" title={t("app.settings.voice")}>
          <button type="button" className={s.row} onClick={() => setVoice(true)} data-testid="settings-voice">
            <span className={s.tile} data-tone="cut" aria-hidden="true">
              <Icon icon={Mic} />
            </span>
            <Label name={withCommand(t("app.settings.voiceTry"))} />
            <Icon icon={ChevronRight} className={s.chev} />
          </button>
        </Group>

        <Group id="settings-legal-h" title={t("app.settings.legal")}>
          {(
            [
              ["/imprint", "site.footer.imprint"],
              ["/privacy", "site.footer.privacy"],
              ["/terms", "site.footer.terms"],
            ] as const
          ).map(([href, key]) => (
            <Link key={href} href={href} className={s.row}>
              <span className={s.tile} aria-hidden="true">
                <Icon icon={FileText} />
              </span>
              <Label name={t(key)} />
              <Icon icon={ChevronRight} className={s.chev} />
            </Link>
          ))}
        </Group>

        <p className={s.note}>
          {billing ? <Link href="/pricing">{t("common.auth.pricing")}</Link> : t("app.settings.beta")}
        </p>
      </div>
      {voice && <VoiceTestDialog onClose={closeVoice} />}
    </AppPage>
  );
}

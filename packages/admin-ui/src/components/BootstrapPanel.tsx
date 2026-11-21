import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Check, ChevronRight, Copy, KeyRound, Server, UserRoundPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AdminApi, ApiError, type Identity } from "../lib/api";
import { toErrorMessage } from "../lib/error";
import { defaultGatewayUrl, normalizeBaseUrl } from "../lib/envs";
import type { SettingsDraft } from "./SettingsBar";

type Step = "choose" | "address" | "create" | "copy" | "login";

function validGatewayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

async function copyToken(token: string) {
  try {
    await navigator.clipboard.writeText(token);
  } catch {
    // A self-hosted gateway can serve its management UI over plain HTTP.
    const field = document.createElement("textarea");
    const previousFocus = document.activeElement;
    field.value = token;
    field.readOnly = true;
    field.className = "setup-clipboard";
    document.body.append(field);
    try {
      field.select();
      if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
    } finally {
      field.remove();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    }
  }
}

export function BootstrapPanel({
  desktop = false,
  secretDegraded = false,
  onDone,
}: {
  desktop?: boolean;
  secretDegraded?: boolean;
  onDone: (draft: SettingsDraft, identity: Identity) => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>(desktop ? "choose" : "login");
  const [creating, setCreating] = useState(false);
  const [address, setAddress] = useState(desktop ? "" : defaultGatewayUrl);
  const [name, setName] = useState("root");
  const [adminToken, setAdminToken] = useState("");
  const [managementToken, setManagementToken] = useState("");
  const [issuedToken, setIssuedToken] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const gatewayUrl = normalizeBaseUrl(address);
  const steps: Step[] = desktop ? ["choose", "address"] : [];
  if (creating) steps.push("create", "copy");
  steps.push("login");
  const position = steps.indexOf(step);

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const go = (next: Step) => {
    setError(null);
    setStep(next);
  };

  const choose = (create: boolean) => {
    setCreating(create);
    go(desktop ? "address" : create ? "create" : "login");
  };

  const goBack = () => {
    if (step === "address") go("choose");
    if (step === "create") {
      setAdminToken("");
      if (desktop) go("address");
      else choose(false);
    }
    if (step === "login" && !issuedToken) go("address");
  };

  const copy = async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await copyToken(issuedToken);
      setCopied(true);
    } catch {
      setError(t("bootstrap.copyError"));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (step === "address") {
      if (validGatewayUrl(gatewayUrl)) go(creating ? "create" : "login");
      else setError(t("bootstrap.addressError"));
      return;
    }
    if (step === "copy") {
      if (copied) go("login");
      return;
    }
    const credential = (step === "create" ? adminToken : issuedToken || managementToken).trim();
    if (!credential) return;
    setError(null);
    setBusy(true);
    try {
      const api = new AdminApi({ baseUrl: gatewayUrl, adminToken: credential });
      if (step === "create") {
        const created = await api.createUser({ name: name.trim() || "root", role: "administrator" });
        setIssuedToken(created.management_token);
        setAdminToken("");
        go("copy");
      } else {
        const identity = await api.getMe();
        onDone({ name: "", gatewayUrl, managementToken: credential }, identity);
      }
    } catch (err) {
      setError(step === "login" && err instanceof ApiError && err.status === 401
        ? t("bootstrap.credentialError")
        : toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const Icon = step === "create" ? UserRoundPlus : step === "copy" || step === "login" ? KeyRound : Server;
  const canGoBack = step === "address" || step === "create" || (desktop && step === "login" && !issuedToken);
  const action = step === "create" ? "submit" : step === "login" ? "signIn" : "next";

  return (
    <main className="setup-main">
      <section className="setup-card" aria-labelledby="setup-title">
        {steps.length > 1 && (
          <ol className="setup-progress" aria-label={t("bootstrap.progress")}>
            {steps.map((item, index) => (
              <li key={item} aria-current={item === step ? "step" : undefined} data-complete={index < position}>
                <span>{index < position ? <Check size={12} aria-hidden="true" /> : index + 1}</span>
                <span>{t(`bootstrap.steps.${item}`)}</span>
              </li>
            ))}
          </ol>
        )}
        <div className="setup-content">
          <header className="setup-heading">
            <span className="setup-icon"><Icon size={24} aria-hidden="true" /></span>
            <h1 ref={heading} tabIndex={-1} id="setup-title">{t(`bootstrap.titles.${step}`)}</h1>
            <p>{t(`bootstrap.descriptions.${step}`)}</p>
          </header>
          {secretDegraded && <p className="error" role="alert">{t("settings.secretDegraded")}</p>}
          {step === "choose" ? (
            <div className="setup-choices">
              <button type="button" onClick={() => choose(false)}>
                <KeyRound size={19} aria-hidden="true" />
                <span><strong>{t("bootstrap.existing")}</strong><small>{t("bootstrap.existingHint")}</small></span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
              <button type="button" onClick={() => choose(true)}>
                <UserRoundPlus size={19} aria-hidden="true" />
                <span><strong>{t("bootstrap.entry")}</strong><small>{t("bootstrap.newHint")}</small></span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <form className="setup-form" onSubmit={submit} aria-busy={busy}>
              {step === "address" && (
                <label>{t("settings.url")}
                  <input value={address} onChange={event => setAddress(event.target.value)}
                    placeholder="http://localhost:8787" inputMode="url" spellCheck={false} required />
                </label>
              )}
              {step === "create" && (
                <>
                  <label>{t("bootstrap.adminToken")}
                    <input type="password" autoComplete="off" value={adminToken} readOnly={busy} required
                      onChange={event => setAdminToken(event.target.value)} placeholder="ADMIN_TOKEN" />
                  </label>
                  <label>{t("bootstrap.name")}
                    <input value={name} readOnly={busy} onChange={event => setName(event.target.value)} placeholder="root" />
                  </label>
                </>
              )}
              {step === "copy" && (
                <div className="setup-secret">
                  <code>{issuedToken}</code>
                  <button type="button" disabled={busy} onClick={() => void copy()}>
                    {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                    {t(copied ? "bootstrap.copied" : "bootstrap.copy")}
                  </button>
                </div>
              )}
              {step === "login" && (
                <>
                  <label>{t("settings.url")}
                    <input value={gatewayUrl} readOnly />
                  </label>
                  <label>{t("settings.token")}
                    <input type="password" autoComplete="off" value={issuedToken || managementToken}
                      readOnly={busy || Boolean(issuedToken)} required onChange={event => setManagementToken(event.target.value)}
                      placeholder="lgm_" />
                  </label>
                </>
              )}
              {error && <p className="error setup-error" role="alert">{error}</p>}
              <footer className="setup-actions">
                {canGoBack && <button type="button" disabled={busy} onClick={goBack}>{t("bootstrap.back")}</button>}
                {!desktop && step === "login" && !issuedToken && (
                  <button type="button" disabled={busy} onClick={() => choose(true)}>{t("bootstrap.entry")}</button>
                )}
                <button type="submit" className="primary setup-next" disabled={busy || (step === "copy" && !copied)}>
                  {t(busy && step !== "copy" ? "bootstrap.working" : `bootstrap.${action}`)}
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              </footer>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}

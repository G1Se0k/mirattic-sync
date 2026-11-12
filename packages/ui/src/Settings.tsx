import { browserLang, LANG_NAMES, LANGS, subscribeLang, t, type LangChoice } from "@mirattic/i18n";
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ALERT_DEFAULTS, type AlertPrefs, type Me, type UserSummary } from "@mirattic/types";
import { DeleteAccount, FriendRequestsFrom, Privacy, type SavePrivacy } from "./Privacy";
import { ExperimentalSettings } from "./Experimental";
import { FeedbackSection } from "./Feedback";
import { Avatar, Icon, IconButton } from "./Icons";
import { useAsk } from "./Dialog";
import { platform, TEXT_SIZE } from "./session";

type Props = {
  me: Me;
  blocked: UserSummary[];
  onMeChange: (me: Me) => void;
  /** Home's privacy saves (one account's): Settings may close before an answer comes. */
  savePrivacy: SavePrivacy;
  onUnblock: (userId: string) => void;
  onSignedOut: () => void;
  onClose: () => void;
  banner?: ReactNode;
};

/** Everything that isn't watching together, in groups: a row each, its text left and its control right. */
export function Settings({ me, blocked, onMeChange, savePrivacy: save, onUnblock, onSignedOut, onClose, banner }: Props) {
  const [showBlocked, setShowBlocked] = useState(false);
  return (
    <>
      <header className="topbar">
        <IconButton icon="back" label={t("돌아가기")} onClick={onClose} />
        <h1>{t("설정")}</h1>
      </header>
      <main className="container settings">
        {banner /* a notice from elsewhere (a mention, decision 118), seen first */}
        <section className="profile">
          <Avatar name={me.displayName} src={me.avatarUrl} />
          <div className="grow">
            <strong>{me.displayName}</strong>
            <div className="muted ellipsis">{me.email}</div>
          </div>
          {/* A new tab of the user's own (not the followed one): the account is edited on Mirattic Auth itself. */}
          <button className="secondary small" onClick={() => window.open(ACCOUNT_URL, "_blank", "noopener")}>{t("계정 정보 수정")}</button>
        </section>
        <Group title={t("같이 보기")}>
          <Privacy me={me} save={save} onChange={onMeChange} />
          <AskOnSwitch />
        </Group>
        {platform.preferences?.alerts && <Group title={t("알림")}><Alerts /></Group>}
        {(platform.textSize || platform.language) && <Group title={t("화면")}><Language /><TextSize /></Group>}
        {platform.experimental && <Group title={t("실험 기능")}><ExperimentalSettings /></Group>}
        <Group title={t("개인정보")}>
          <FriendRequestsFrom me={me} save={save} onChange={onMeChange} />
          <div>
            <button className="item" aria-expanded={showBlocked} onClick={() => setShowBlocked((v) => !v)}>
              <span className="text">{t("차단한 사용자")}</span>
              <span className="muted">{t("{n}명", { n: blocked.length })}</span>
              <Icon name="chevron" />
            </button>
            <div className={`fold${showBlocked ? "" : " closed"}`} inert={!showBlocked}>
              <div>
                {blocked.length === 0 ? <p className="muted fold-body">{t("없습니다.")}</p> : (
                  <ul className="list fold-body">
                    {blocked.map((u) => (
                      <li key={u.id} className="row">
                        <Avatar name={u.displayName} src={u.avatarUrl} />
                        <span className="grow ellipsis">{u.displayName}</span>
                        <button className="secondary small" onClick={() => onUnblock(u.id)}>{t("차단 해제")}</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </Group>
        <Group title={t("정보 · 지원")}>
          <Updates />
          <FeedbackSection />
          <div className="item">
            <span className="text">{t("로그아웃")}</span>
            <button className="secondary small" onClick={onSignedOut}>{t("로그아웃")}</button>
          </div>
        </Group>
        <Group title={t("계정 삭제")} danger>
          <DeleteAccount onDeleted={onSignedOut} />
        </Group>
      </main>
    </>
  );
}

/** A titled card of setting rows. */
function Group({ title, danger, children }: { title: string; danger?: boolean; children: ReactNode }) {
  return (
    <section className="group">
      <h2>{title}</h2>
      <div className={`box${danger ? " danger" : ""}`}>{children}</div>
    </section>
  );
}

const noSubscribe = () => () => {};
/** Where the Mirattic account itself (email, password, profile) is edited. */
const ACCOUNT_URL = "https://auth.mirattic.com/";

/** The text size, in percent (only where the platform keeps it). */
/** The language on this device (decision 124): each by its own name, "자동" the browser's. */
function Language() {
  const language = platform.language;
  // As chosen now, here or in another panel (shown at once by `set`, followed from storage by every page).
  const choice = useSyncExternalStore(subscribeLang, () => language?.get() ?? "auto");
  const [failed, setFailed] = useState(false);
  if (!language) return null;
  const choose = (next: LangChoice) => {
    setFailed(false);
    language.set(next).catch(() => setFailed(true));
  };
  return (
    <label className="item">
      <span className="text">
        {t("표시 언어")}
        <span className="muted">{t("패널과 영상 위 알림의 언어입니다. 이 기기에만 저장됩니다. English · 日本語는 AI 번역을 이용했습니다.")}</span>
        {failed && <span className="error" role="alert">{t("저장하지 못했습니다. 패널을 다시 열면 이전 언어로 돌아갈 수 있습니다.")}</span>}
      </span>
      <select value={choice} onChange={(e) => choose(e.target.value as LangChoice)}>
        <option value="auto">{t("자동 ({name})", { name: LANG_NAMES[browserLang()] })}</option>
        {LANGS.map((l) => <option key={l} value={l}>{LANG_NAMES[l]}</option>)}
      </select>
    </label>
  );
}

function TextSize() {
  const size = platform.textSize;
  const percent = useSyncExternalStore(platform.subscribe ?? noSubscribe, () => size?.get() ?? TEXT_SIZE.normal);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);
  if (!size) return null;
  /** Each step is a choice, saved at once; the error shows the latest choice's save only. */
  const choose = (value: number) => {
    const mine = ++latest.current;
    setFailed(false);
    size.set(value).then(
      () => mine === latest.current && setFailed(false),
      () => mine === latest.current && setFailed(true),
    );
  };
  return (
    <div className="item">
      <span className="text">
        {t("글자 크기")}
        {failed && <span className="error" role="alert">{t("저장하지 못했습니다. 패널을 다시 열면 이전 크기로 돌아갈 수 있습니다.")}</span>}
      </span>
      {(percent !== TEXT_SIZE.normal || failed) && (
        <button className="secondary small" onClick={() => choose(TEXT_SIZE.normal)}>{t("기본")}</button>
      )}
      <span className="stepper">
        <button aria-label={t("글자 작게")} disabled={percent <= TEXT_SIZE.min} onClick={() => choose(percent - TEXT_SIZE.step)}>−</button>
        <output aria-live="polite">{percent}%</output>
        <button aria-label={t("글자 크게")} disabled={percent >= TEXT_SIZE.max} onClick={() => choose(percent + TEXT_SIZE.step)}>+</button>
      </span>
    </div>
  );
}

/** Whether a member is asked before following the host to another video (decision 81). Only where kept. */
function AskOnSwitch() {
  const prefs = platform.preferences;
  const ask = useSyncExternalStore(platform.subscribe ?? noSubscribe, () => prefs?.askOnSwitch() ?? true);
  if (!prefs) return null;
  return (
    <label className="item">
      <span className="text">
        {t("다른 영상으로 옮길 때 묻기")}
        <span className="muted">{t("호스트가 다른 영상으로 옮기면 따라갈지 묻습니다. 끄면 묻지 않고 따라가고, 같은 재생목록·작품의 다음 영상은 켜 두어도 묻지 않습니다.")}</span>
      </span>
      <span className="switch">
        <input type="checkbox" role="switch" checked={ask} onChange={(e) => void prefs.setAskOnSwitch(e.target.checked)} />
        <span aria-hidden="true" />
      </span>
    </label>
  );
}

/** What alerts this device shows (decision 119), saved at once; 방해 금지 is the me bar's status (decision 120). */
function Alerts() {
  const prefs = platform.preferences;
  const now = useSyncExternalStore(platform.subscribe ?? noSubscribe, () => prefs?.alerts?.() ?? ALERT_DEFAULTS);
  const set = (change: Partial<AlertPrefs>) => void prefs?.setAlerts?.(change);
  const row = (key: keyof AlertPrefs, title: string, about?: string, sub?: boolean, disabled?: boolean) => (
    <label className={`item${sub ? " sub" : ""}`}>
      <span className="text">
        {title}
        {about && <span className="muted">{about}</span>}
      </span>
      <span className="switch">
        <input type="checkbox" role="switch" checked={now[key]} disabled={disabled} onChange={(e) => set({ [key]: e.target.checked })} />
        <span aria-hidden="true" />
      </span>
    </label>
  );
  return (
    <>
      {row("mentions", t("멘션 알림"), t("나를 언급하면 토스트 · 배지 · 배너로 알립니다. 꺼도 채팅의 노란 강조는 남습니다."))}
      {row("everyone", t("방장의 @everyone도 알림"), undefined, true, !now.mentions)}
    </>
  );
}

type UpdateState = "idle" | "checking" | "latest" | "throttled" | "failed" | { available: string };

/** This version, a check for a newer one in the store, and a restart into it (only where the platform has them). */
function Updates() {
  const updates = platform.updates;
  const asker = useAsk();
  const [state, setState] = useState<UpdateState>("idle");
  const ready = useSyncExternalStore(platform.subscribe ?? noSubscribe, () => updates?.ready() ?? null);
  if (!updates) return null;

  async function check() {
    setState("checking");
    try {
      const r = await updates!.check();
      setState(r.status === "available" ? { available: r.version } : r.status);
    } catch {
      setState("failed"); // e.g. not installed from the store (a developer build)
    }
  }

  async function apply() {
    const inRoom = !!platform.activeRoom?.();
    const yes = await asker.ask(t("지금 업데이트할까요?"), {
      body: inRoom ? t("확장이 다시 시작되어 패널이 닫힙니다. 방 연결도 잠시 끊기며, 패널을 다시 열어 방에 들어가면 됩니다.")
        : t("확장이 다시 시작되어 패널이 닫힙니다."),
      ok: t("업데이트"),
    });
    if (yes) updates!.apply();
  }

  const note = ready ? t("새 버전 {ready}을 받았습니다. 다시 시작하면 적용됩니다.", { ready })
    : typeof state === "object" ? t("새 버전 {available}을 내려받는 중입니다. 다 받으면 업데이트할 수 있고, 그 전에 브라우저를 다시 열어도 적용됩니다.", { available: state.available })
    : state === "latest" ? t("최신 버전입니다.")
    : state === "throttled" ? t("방금 확인했습니다. 잠시 후 다시 확인해 주세요.")
    : state === "failed" ? t("확인할 수 없습니다. 스토어에서 설치한 확장에서만 확인할 수 있습니다.")
    : null;
  return (
    <div className="item">
      <span className="text">
        <span>{t("버전")} <span className="num">{updates.version}</span></span>
        {note && <span className="muted" role="status">{note}</span>}
      </span>
      {ready
        ? <button className="small" onClick={() => void apply()}>{t("지금 업데이트")}</button>
        : typeof state === "object" ? null
        : <button className="secondary small" disabled={state === "checking"} onClick={() => void check()}>
            {state === "checking" ? t("확인 중…") : t("업데이트 확인")}
          </button>}
      {asker.dialog}
    </div>
  );
}

/** My code, shown where friends are added. */
export function MyFriendCode({ me }: { me: Me }) {
  const [copied, setCopied] = useState(false);
  const code = `${me.friendCode.slice(0, 4)}-${me.friendCode.slice(4)}`;

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section>
      <h2>{t("내 친구 코드")}</h2>
      <div className="card row">
        <code className="code grow">{code}</code>
        <IconButton icon={copied ? "check" : "copy"} label={copied ? t("복사됨") : t("복사")} onClick={() => void copy()} />
      </div>
    </section>
  );
}

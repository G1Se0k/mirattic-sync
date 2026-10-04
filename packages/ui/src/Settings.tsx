import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Me, UserSummary } from "@mirattic/types";
import { DeleteAccount, Privacy } from "./Privacy";
import { ExperimentalSettings } from "./Experimental";
import { FeedbackSection } from "./Feedback";
import { Avatar, Icon, IconButton } from "./Icons";
import { useAsk } from "./Dialog";
import { platform, TEXT_SIZE } from "./session";

type Props = {
  me: Me;
  blocked: UserSummary[];
  onMeChange: (me: Me) => void;
  onUnblock: (userId: string) => void;
  onSignedOut: () => void;
  onClose: () => void;
};

/** Everything that isn't watching together, in groups: a row each, its text left and its control right. */
export function Settings({ me, blocked, onMeChange, onUnblock, onSignedOut, onClose }: Props) {
  const [showBlocked, setShowBlocked] = useState(false);
  return (
    <>
      <header className="topbar">
        <IconButton icon="back" label="돌아가기" onClick={onClose} />
        <h1>설정</h1>
      </header>
      <main className="container settings">
        <section className="profile">
          <Avatar name={me.displayName} />
          <div className="grow">
            <strong>{me.displayName}</strong>
            <div className="muted ellipsis">{me.email}</div>
          </div>
          {/* A new tab of the user's own (not the followed one): the account is edited on Mirattic Auth itself. */}
          <button className="secondary small" onClick={() => window.open(ACCOUNT_URL, "_blank", "noopener")}>계정 정보 수정</button>
        </section>
        <Group title="같이 보기">
          <Privacy me={me} onChange={onMeChange} />
          <AskOnSwitch />
        </Group>
        {platform.textSize && <Group title="화면"><TextSize /></Group>}
        {platform.experimental && <Group title="실험 기능"><ExperimentalSettings /></Group>}
        <Group title="개인정보">
          <div>
            <button className="item" aria-expanded={showBlocked} onClick={() => setShowBlocked((v) => !v)}>
              <span className="text">차단한 사용자</span>
              <span className="muted">{blocked.length}명</span>
              <Icon name="chevron" />
            </button>
            <div className={`fold${showBlocked ? "" : " closed"}`} inert={!showBlocked}>
              <div>
                {blocked.length === 0 ? <p className="muted fold-body">없습니다.</p> : (
                  <ul className="list fold-body">
                    {blocked.map((u) => (
                      <li key={u.id} className="row">
                        <Avatar name={u.displayName} />
                        <span className="grow ellipsis">{u.displayName}</span>
                        <button className="secondary small" onClick={() => onUnblock(u.id)}>차단 해제</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </Group>
        <Group title="정보 · 지원">
          <Updates />
          <FeedbackSection />
          <div className="item">
            <span className="text">로그아웃</span>
            <button className="secondary small" onClick={onSignedOut}>로그아웃</button>
          </div>
        </Group>
        <Group title="계정 삭제" danger>
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
        글자 크기
        {failed && <span className="error" role="alert">저장하지 못했습니다. 패널을 다시 열면 이전 크기로 돌아갈 수 있습니다.</span>}
      </span>
      {(percent !== TEXT_SIZE.normal || failed) && (
        <button className="secondary small" onClick={() => choose(TEXT_SIZE.normal)}>기본</button>
      )}
      <span className="stepper">
        <button aria-label="글자 작게" disabled={percent <= TEXT_SIZE.min} onClick={() => choose(percent - TEXT_SIZE.step)}>−</button>
        <output aria-live="polite">{percent}%</output>
        <button aria-label="글자 크게" disabled={percent >= TEXT_SIZE.max} onClick={() => choose(percent + TEXT_SIZE.step)}>+</button>
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
        다른 영상으로 옮길 때 묻기
        <span className="muted">호스트가 다른 영상으로 옮기면 따라갈지 묻습니다. 끄면 묻지 않고 따라가고, 같은 재생목록·작품의 다음 영상은 켜 두어도 묻지 않습니다.</span>
      </span>
      <span className="switch">
        <input type="checkbox" role="switch" checked={ask} onChange={(e) => void prefs.setAskOnSwitch(e.target.checked)} />
        <span aria-hidden="true" />
      </span>
    </label>
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
    const yes = await asker.ask("지금 업데이트할까요?", {
      body: `확장이 다시 시작되어 패널이 닫힙니다.${inRoom ? " 방 연결도 잠시 끊기며, 패널을 다시 열어 방에 들어가면 됩니다." : ""}`,
      ok: "업데이트",
    });
    if (yes) updates!.apply();
  }

  const note = ready ? `새 버전 ${ready}을 받았습니다. 다시 시작하면 적용됩니다.`
    : typeof state === "object" ? `새 버전 ${state.available}을 내려받는 중입니다. 다 받으면 업데이트할 수 있고, 그 전에 브라우저를 다시 열어도 적용됩니다.`
    : state === "latest" ? "최신 버전입니다."
    : state === "throttled" ? "방금 확인했습니다. 잠시 후 다시 확인해 주세요."
    : state === "failed" ? "확인할 수 없습니다. 스토어에서 설치한 확장에서만 확인할 수 있습니다."
    : null;
  return (
    <div className="item">
      <span className="text">
        <span>버전 <span className="num">{updates.version}</span></span>
        {note && <span className="muted" role="status">{note}</span>}
      </span>
      {ready
        ? <button className="small" onClick={() => void apply()}>지금 업데이트</button>
        : typeof state === "object" ? null
        : <button className="secondary small" disabled={state === "checking"} onClick={() => void check()}>
            {state === "checking" ? "확인 중…" : "업데이트 확인"}
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
      <h2>내 친구 코드</h2>
      <div className="card row">
        <code className="code grow">{code}</code>
        <IconButton icon={copied ? "check" : "copy"} label={copied ? "복사됨" : "복사"} onClick={() => void copy()} />
      </div>
    </section>
  );
}

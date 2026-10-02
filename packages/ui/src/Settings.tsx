import { useRef, useState, useSyncExternalStore } from "react";
import type { Me, UserSummary } from "@mirattic/types";
import { DeleteAccount, Privacy } from "./Privacy";
import { ExperimentalSettings } from "./Experimental";
import { Avatar, IconButton } from "./Icons";
import { platform, TEXT_SIZE } from "./session";

type Props = {
  me: Me;
  blocked: UserSummary[];
  onMeChange: (me: Me) => void;
  onUnblock: (userId: string) => void;
  onSignedOut: () => void;
  onClose: () => void;
};

/** Everything that isn't watching together: my code, visibility, experiments, blocks, the account. */
export function Settings({ me, blocked, onMeChange, onUnblock, onSignedOut, onClose }: Props) {
  const [showBlocked, setShowBlocked] = useState(false);
  return (
    <>
      <header className="topbar">
        <IconButton icon="back" label="돌아가기" onClick={onClose} />
        <h1>설정</h1>
      </header>
      <main className="container">
        <section className="row">
          <Avatar name={me.displayName} />
          <div className="grow">
            <strong>{me.displayName}</strong>
            <div className="muted ellipsis">{me.email}</div>
          </div>
          <IconButton icon="logout" label="로그아웃" onClick={onSignedOut} />
        </section>
        <Privacy me={me} onChange={onMeChange} />
        <TextSize />
        <AskOnSwitch />
        <ExperimentalSettings />
        <section>
          <button className="secondary" aria-expanded={showBlocked} onClick={() => setShowBlocked((v) => !v)}>
            차단한 사용자 ({blocked.length}) {showBlocked ? "닫기" : "보기"}
          </button>
          {showBlocked && blocked.length === 0 && <p className="muted">없습니다.</p>}
          {showBlocked && (
            <ul className="list">
              {blocked.map((u) => (
                <li key={u.id} className="friend">
                  <Avatar name={u.displayName} />
                  <span className="grow name">{u.displayName}</span>
                  <button className="secondary" onClick={() => onUnblock(u.id)}>차단 해제</button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <DeleteAccount onDeleted={onSignedOut} />
      </main>
    </>
  );
}

const noSubscribe = () => () => {};

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
    <section>
      <div className="row text-size-row">
        <span className="grow">글자 크기</span>
        <button className="secondary" aria-label="글자 작게" disabled={percent <= TEXT_SIZE.min}
          onClick={() => choose(percent - TEXT_SIZE.step)}>−</button>
        <strong className="text-size" aria-live="polite">{percent}%</strong>
        <button className="secondary" aria-label="글자 크게" disabled={percent >= TEXT_SIZE.max}
          onClick={() => choose(percent + TEXT_SIZE.step)}>+</button>
        <button className="secondary" disabled={percent === TEXT_SIZE.normal && !failed} onClick={() => choose(TEXT_SIZE.normal)}>
          기본
        </button>
      </div>
      {failed && <p className="error" role="alert">글자 크기를 저장하지 못했습니다. 패널을 다시 열면 이전 크기로 돌아갈 수 있습니다.</p>}
    </section>
  );
}

/** Whether a member is asked before following the host to another video (decision 81). Only where kept. */
function AskOnSwitch() {
  const prefs = platform.preferences;
  const ask = useSyncExternalStore(platform.subscribe ?? noSubscribe, () => prefs?.askOnSwitch() ?? true);
  if (!prefs) return null;
  return (
    <section>
      <label className="row">
        <input type="checkbox" checked={ask} onChange={(e) => void prefs.setAskOnSwitch(e.target.checked)} />
        <span className="grow">호스트가 다른 영상으로 옮기면 따라갈지 물어보기</span>
      </label>
      <p className="muted">끄면 묻지 않고 따라갑니다. 같은 재생목록·작품의 다음 영상은 켜 두어도 묻지 않고 따라갑니다.</p>
    </section>
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

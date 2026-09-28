import { useState } from "react";
import type { Me, UserSummary } from "@mirattic/types";
import { api } from "./session";
import { DeleteAccount, Privacy } from "./Privacy";
import { ExperimentalSettings } from "./Experimental";
import { Avatar, IconButton } from "./Icons";

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
        <MyFriendCode me={me} onMeChange={onMeChange} />
        <Privacy me={me} onChange={onMeChange} />
        <ExperimentalSettings />
        <section>
          <h2>차단한 사용자</h2>
          {blocked.length === 0 && <p className="muted">없습니다.</p>}
          <ul className="list">
            {blocked.map((u) => (
              <li key={u.id} className="friend">
                <Avatar name={u.displayName} />
                <span className="grow name">{u.displayName}</span>
                <button className="secondary" onClick={() => onUnblock(u.id)}>차단 해제</button>
              </li>
            ))}
          </ul>
        </section>
        <DeleteAccount onDeleted={onSignedOut} />
      </main>
    </>
  );
}

function MyFriendCode({ me, onMeChange }: { me: Me; onMeChange: (me: Me) => void }) {
  const [copied, setCopied] = useState(false);
  const code = `${me.friendCode.slice(0, 4)}-${me.friendCode.slice(4)}`;

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function regenerate() {
    if (!confirm("새 코드를 발급하면 지금 코드로는 더 이상 친구 요청을 받을 수 없습니다. 계속할까요?")) return;
    await api.regenerateFriendCode().then(onMeChange, () => {});
  }

  return (
    <section>
      <h2>내 친구 코드</h2>
      <div className="card row">
        <code className="code grow">{code}</code>
        <IconButton icon={copied ? "check" : "copy"} label={copied ? "복사됨" : "복사"} onClick={() => void copy()} />
        <IconButton icon="refresh" label="새로 발급" onClick={() => void regenerate()} />
      </div>
      <p className="muted">친구에게 이 코드를 알려주면 친구 요청을 받을 수 있습니다.</p>
    </section>
  );
}

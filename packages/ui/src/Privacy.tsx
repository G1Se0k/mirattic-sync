import type { Me, Visibility } from "@mirattic/types";
import { api } from "./session";

const LABELS: Record<Visibility, string> = { OFF: "공유 안 함", FRIENDS: "친구", ROOM_ONLY: "같은 방에서만" };

export function Privacy({ me, onChange }: { me: Me; onChange: (me: Me) => void }) {
  const update = (presence: Visibility, position: Visibility) =>
    api.updatePrivacy(presence, position).then(onChange, () => {});

  return (
    <section>
      <h2>공개 범위</h2>
      <label className="row between">
        시청 중인 콘텐츠
        <select value={me.presenceVisibility} onChange={(e) => update(e.target.value as Visibility, me.positionVisibility)}>
          {(["FRIENDS", "ROOM_ONLY", "OFF"] as const).map((v) => <option key={v} value={v}>{LABELS[v]}</option>)}
        </select>
      </label>
      <label className="row between">
        재생 위치
        <select value={me.positionVisibility} onChange={(e) => update(me.presenceVisibility, e.target.value as Visibility)}>
          {(["ROOM_ONLY", "FRIENDS", "OFF"] as const).map((v) => <option key={v} value={v}>{LABELS[v]}</option>)}
        </select>
      </label>
    </section>
  );
}

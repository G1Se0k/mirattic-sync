import { useState, useSyncExternalStore } from "react";
import { platform } from "./session";

const noSubscribe = () => () => {};

/** Whether experimental Netflix control is on, re-rendering when it changes. undefined = not offered here. */
export function useNetflixControl() {
  const on = useSyncExternalStore(platform.subscribe ?? noSubscribe, () => platform.experimental?.enabled("netflix") ?? false);
  return platform.experimental ? on : undefined;
}

/**
 * Turning on Netflix control, with the risk spelled out first (docs/platform-policy/netflix.md).
 * Shown in the settings and, as a dialog, on first entering a Netflix room.
 */
export function NetflixControl({ onDone }: { onDone?: () => void }) {
  const on = useNetflixControl();
  const [failed, setFailed] = useState(false);
  if (on === undefined) return null;

  async function set(next: boolean) {
    setFailed(false);
    const ok = await platform.experimental!.setEnabled("netflix", next).catch(() => false);
    if (next && !ok) return setFailed(true);
    onDone?.();
  }

  return (
    <div className="stack">
      <p>
        Netflix 이용약관 1.8조는 "코드나 다른 제품을 삽입하거나 어떤 방식으로든 Netflix 서비스 콘텐츠 조작"을 금지합니다.
        이 기능은 Netflix 탭에 확장 프로그램 코드를 넣어 재생을 맞추므로 이 조항에 해당할 수 있고,
        <strong> Netflix가 내 계정을 제한할 수 있습니다.</strong> 실험 기능이며 위험은 사용자에게 있습니다.
      </p>
      <ul className="muted">
        <li>읽는 것: 주소의 콘텐츠 ID, 탭 제목, 재생 위치·상태 (공개 범위 설정대로 친구·방에 공유)</li>
        <li>하는 것: 재생 / 일시정지만. 위치 이동은 하지 않고 어디로 옮길지 안내만 합니다</li>
        <li>광고 요금제는 지원하지 않습니다</li>
        <li>켜면 Chrome이 netflix.com 접근 권한을 묻고, 끄면 권한을 돌려줍니다</li>
      </ul>
      {failed && <p className="error">권한을 받지 못해 켜지 않았습니다.</p>}
      <div className="row">
        {on ? (
          <button onClick={() => void set(false)}>Netflix 제어 끄기</button>
        ) : (
          <button onClick={() => void set(true)}>위험을 이해하고 켜기</button>
        )}
        {onDone && <button className="link" onClick={onDone}>{on ? "닫기" : "켜지 않고 계속"}</button>}
      </div>
    </div>
  );
}

export function ExperimentalSettings() {
  const on = useNetflixControl();
  if (on === undefined) return null;
  return (
    <section>
      <h2>실험 기능 · Netflix 제어 {on ? "(켜짐)" : "(꺼짐)"}</h2>
      <NetflixControl />
    </section>
  );
}

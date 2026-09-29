import { useState, useSyncExternalStore, type ReactNode } from "react";
import type { MediaProvider } from "@mirattic/types";
import { platform } from "./session";
import { PROVIDER_NAMES } from "./format";

const noSubscribe = () => () => {};

/** Providers controlled only after the user accepts the risk (docs/platform-policy/{netflix,laftel}.md). */
export const EXPERIMENTS = ["netflix", "laftel"] as const satisfies MediaProvider[];
export type Experiment = (typeof EXPERIMENTS)[number];
export const isExperiment = (p?: MediaProvider): p is Experiment => EXPERIMENTS.includes(p as Experiment);

const RISK: Record<Experiment, { terms: ReactNode; reads: string; does: string; site: string }> = {
  netflix: {
    terms: (
      <>
        Netflix 이용약관 1.8조는 "코드나 다른 제품을 삽입하거나 어떤 방식으로든 Netflix 서비스 콘텐츠 조작"을 금지합니다.
        이 기능은 Netflix 탭에 확장 프로그램 코드를 넣고 Netflix 플레이어의 비공개 내부 기능으로 위치를 맞추므로 이 조항에 해당할 수 있고,
        <strong> Netflix가 내 계정을 제한할 수 있습니다.</strong>
      </>
    ),
    reads: "주소의 콘텐츠 ID, 탭 제목과 플레이어 제목 줄, Netflix 페이지 안의 재생 정보(작품 ID·작품명·시즌·화·화 제목), 재생 위치·상태",
    does: "재생 / 일시정지 / 위치 이동 (Netflix 내부 기능이 바뀌어 이동이 안 되면 어디로 옮길지 안내)",
    site: "netflix.com",
  },
  laftel: {
    terms: (
      <>
        라프텔은 제3자 확장 프로그램에 대한 개발자 정책을 따로 두고 있지 않고, 이 기능을 허용한다고 밝힌 적도 없습니다.
        이 기능은 라프텔 탭에 확장 프로그램 코드를 넣어 재생을 맞추므로,
        <strong> 라프텔이 약관 위반으로 보고 내 계정을 제한할 수 있습니다.</strong>
      </>
    ),
    reads: "주소의 작품·에피소드 ID, 탭 제목(작품명·화수), 재생 위치·상태",
    does: "재생 / 일시정지 / 위치 이동",
    site: "laftel.net",
  },
};

/** Whether experimental control of `provider` is on, re-rendering when it changes. undefined = not offered here. */
export function useExperiment(provider?: Experiment) {
  const on = useSyncExternalStore(platform.subscribe ?? noSubscribe, () => !!provider && (platform.experimental?.enabled(provider) ?? false));
  return platform.experimental ? on : undefined;
}

/**
 * Turning on control of `provider`, with the risk spelled out first.
 * Shown in the settings and, as a dialog, on first entering a room of that provider.
 */
export function ExperimentControl({ provider, onDone }: { provider: Experiment; onDone?: () => void }) {
  const on = useExperiment(provider);
  const [failed, setFailed] = useState(false);
  if (on === undefined) return null;
  const name = PROVIDER_NAMES[provider];
  const risk = RISK[provider];

  async function set(next: boolean) {
    setFailed(false);
    const ok = await platform.experimental!.setEnabled(provider, next).catch(() => false);
    if (next && !ok) return setFailed(true);
    onDone?.();
  }

  return (
    <div className="stack">
      <p>{risk.terms} 실험 기능이며 위험은 사용자에게 있습니다.</p>
      <ul className="muted">
        <li>읽는 것: {risk.reads} (공개 범위 설정대로 친구·방에 공유)</li>
        <li>하는 것: {risk.does}</li>
        <li>광고가 나오는 재생은 지원하지 않습니다</li>
        <li>켜면 Chrome이 {risk.site} 접근 권한을 묻고, 끄면 권한을 돌려줍니다</li>
      </ul>
      {failed && <p className="error">권한을 받지 못해 켜지 않았습니다.</p>}
      <div className="row">
        {on ? (
          <button onClick={() => void set(false)}>{name} 제어 끄기</button>
        ) : (
          <button onClick={() => void set(true)}>위험을 이해하고 켜기</button>
        )}
        {onDone && <button className="link" onClick={onDone}>{on ? "닫기" : "켜지 않고 계속"}</button>}
      </div>
    </div>
  );
}

function ExperimentSection({ provider }: { provider: Experiment }) {
  const on = useExperiment(provider);
  if (on === undefined) return null;
  return (
    <section>
      <h2>실험 기능 · {PROVIDER_NAMES[provider]} 제어 {on ? "(켜짐)" : "(꺼짐)"}</h2>
      <ExperimentControl provider={provider} />
    </section>
  );
}

export function ExperimentalSettings() {
  return (
    <>
      {EXPERIMENTS.map((p) => (
        <ExperimentSection key={p} provider={p} />
      ))}
    </>
  );
}

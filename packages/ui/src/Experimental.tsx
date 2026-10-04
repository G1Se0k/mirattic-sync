import { useState, useSyncExternalStore, type ReactNode } from "react";
import type { MediaProvider } from "@mirattic/types";
import { platform } from "./session";
import { PROVIDER_NAMES } from "./format";
import { Actions, Dialog } from "./Dialog";
import { Icon } from "./Icons";

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
/** `onDone(true)` once it was turned on (saved), `onDone(false)` when left off or closed. */
/** `declineLabel`: the "not now" button's label where declining means something more (e.g. leaving a room). */
export function ExperimentControl({ provider, onDone, declineLabel }: {
  provider: Experiment;
  onDone?: (turnedOn: boolean) => void;
  declineLabel?: string;
}) {
  const on = useExperiment(provider);
  const [failed, setFailed] = useState(false);
  if (on === undefined) return null;
  const name = PROVIDER_NAMES[provider];

  async function set(next: boolean) {
    setFailed(false);
    const ok = await platform.experimental!.setEnabled(provider, next).catch(() => false);
    if (next && !ok) return setFailed(true);
    onDone?.(next);
  }

  return (
    <div className="stack">
      <RiskDetails provider={provider} />
      {failed && <p className="error">켜지 못했습니다. 다시 시도하세요.</p>}
      <Actions>
        {onDone && <button className="link" onClick={() => onDone(!!on)}>{on ? "닫기" : declineLabel ?? "켜지 않고 계속"}</button>}
        {on ? (
          <button onClick={() => void set(false)}>{name} 제어 끄기</button>
        ) : (
          <button onClick={() => void set(true)}>위험을 이해하고 켜기</button>
        )}
      </Actions>
    </div>
  );
}

/** What turning it on means: the terms risk, what is read and done. */
function RiskDetails({ provider }: { provider: Experiment }) {
  const risk = RISK[provider];
  return (
    <>
      <p>{risk.terms} 실험 기능이며 위험은 사용자에게 있습니다.</p>
      <ul className="muted">
        <li>읽는 것: {risk.reads} (공개 범위 설정대로 친구·방에 공유)</li>
        <li>하는 것: {risk.does}</li>
        <li>광고가 나오는 재생은 지원하지 않습니다</li>
        <li>{risk.site} 접근 권한은 설치 때 받지만, 켜기 전에는 그 사이트에 들어간 것만 알아채 안내하고 페이지는 읽지 않습니다</li>
      </ul>
    </>
  );
}

/** Settings: a row per site with its state; opened, its risks and the button to turn it on or off. */
function ExperimentSection({ provider }: { provider: Experiment }) {
  const on = useExperiment(provider);
  const [open, setOpen] = useState(false);
  if (on === undefined) return null;
  const name = PROVIDER_NAMES[provider];
  return (
    <div>
      <button className="item" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="text">
          <span>{name} 제어 <span className={`pill${on ? " on" : ""}`}>{on ? "켜짐" : "꺼짐"}</span></span>
          <span className="muted">{on ? "끄려면 펼치세요" : "켜기 전에 위험을 확인하세요"}</span>
        </span>
        <Icon name="chevron" />
      </button>
      <div className={`fold${open ? "" : " closed"}`} inert={!open}>
        <div>
          <div className="fold-body risk stack">
            <RiskDetails provider={provider} />
            <div>
              <button className={`small${on ? " secondary" : ""}`} onClick={() => void platform.experimental!.setEnabled(provider, !on)}>
                {on ? `${name} 제어 끄기` : "위험을 이해하고 켜기"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The window's active tab is on Netflix / Laftel with its control off (decision 81): offered once per arrival
 * there, with the risks. Shown on any screen.
 */
export function OffSitePrompt() {
  const off = useSyncExternalStore(platform.subscribe ?? noSubscribe, () => platform.offSite?.() ?? null);
  const [dismissed, setDismissed] = useState(0);
  if (!off || off.visit === dismissed || !isExperiment(off.provider)) return null;
  return (
    <Dialog title={`${PROVIDER_NAMES[off.provider]}에서 같이 보려면 제어를 켜야 합니다`} onClose={() => setDismissed(off.visit)}>
      <ExperimentControl provider={off.provider} onDone={() => setDismissed(off.visit)} />
    </Dialog>
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

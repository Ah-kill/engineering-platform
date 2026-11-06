import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useResource } from '../hooks';

// ---- API shape (GET /api/usage) ---------------------------------------------

interface Numbers { costUsd: number; inputTokens: number; outputTokens: number; sessions: number }
interface UsageReport {
  from: string;
  to: string;
  scope: 'org' | 'self';
  totals: Numbers;
  byDay: (Numbers & { day: string })[];
  byUser: (Numbers & { userId: string; email: string; displayName: string })[];
  byApplication: (Numbers & { applicationId: string; applicationName: string; clientId: string; clientName: string })[];
  byModel: (Numbers & { model: string })[];
}

// ---- formatting ---------------------------------------------------------------

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdAxis = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat('en-US');

const money = (n: number) => (n > 0 && n < 0.005 ? '<$0.01' : usd.format(n));
const shortDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Today as a UTC day, which is how the API buckets usage. */
const todayUtc = () => new Date().toISOString().slice(0, 10);
const daysBefore = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

const PRESETS = [7, 30, 90] as const;

// ---- page -----------------------------------------------------------------------

export function UsagePage() {
  const [range, setRange] = useState(() => ({ from: daysBefore(todayUtc(), 29), to: todayUtc() }));
  const invalid = range.from > range.to ? 'The start date must be on or before the end date.' : undefined;
  const { data, error, loading } = useResource<UsageReport>(invalid ? null : `/usage?from=${range.from}&to=${range.to}`);

  const today = todayUtc();
  const activePreset = range.to === today ? PRESETS.find((n) => range.from === daysBefore(today, n - 1)) : undefined;

  return (
    <div className="stack usage">
      <div className="page-head">
        <div>
          <h1>Usage</h1>
          <div className="muted">
            {data?.scope === 'org' ? 'Claude usage and cost across the organization.' : 'Your Claude usage and cost.'}
          </div>
        </div>
      </div>

      <div className="usage-controls" role="group" aria-label="Date range">
        <div className="usage-presets" role="group" aria-label="Quick ranges">
          {PRESETS.map((n) => (
            <button
              key={n}
              type="button"
              className={activePreset === n ? 'primary' : undefined}
              aria-pressed={activePreset === n}
              onClick={() => setRange({ from: daysBefore(today, n - 1), to: today })}
            >
              {n} days
            </button>
          ))}
        </div>
        <label>
          From
          <input type="date" value={range.from} max={range.to} required
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))} />
        </label>
        <label>
          To
          <input type="date" value={range.to} min={range.from} max={today} required
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))} />
        </label>
      </div>

      {(invalid ?? error) && <div className="error" role="alert">{invalid ?? error?.message}</div>}
      {!data && loading && !invalid && <p className="muted">Loading…</p>}

      {data && (
        <div className="stack" aria-busy={loading}>
          <div className="usage-tiles">
            <Tile label="Cost" value={money(data.totals.costUsd)} />
            <Tile label="Conversations" value={whole.format(data.totals.sessions)} />
            <Tile label="Input tokens" value={compact.format(data.totals.inputTokens)} title={whole.format(data.totals.inputTokens)} />
            <Tile label="Output tokens" value={compact.format(data.totals.outputTokens)} title={whole.format(data.totals.outputTokens)} />
          </div>

          <section className="card">
            <h2>Cost per day</h2>
            <CostChart days={data.byDay} />
          </section>

          <Breakdown
            title="By application"
            empty="No conversations in this range."
            rows={data.byApplication}
            total={data.totals.costUsd}
            keyOf={(r) => r.applicationId}
            head={['Client', 'Application']}
            cells={(r) => [r.clientName, r.applicationName]}
          />
          {data.scope === 'org' && (
            <Breakdown
              title="By developer"
              empty="No conversations in this range."
              rows={data.byUser}
              total={data.totals.costUsd}
              keyOf={(r) => r.userId}
              head={['Developer']}
              cells={(r) => [<span key="u">{r.displayName} <span className="muted">{r.email}</span></span>]}
            />
          )}
          <Breakdown
            title="By model"
            empty="No conversations in this range."
            rows={data.byModel}
            total={data.totals.costUsd}
            keyOf={(r) => r.model}
            head={['Model']}
            cells={(r) => [<span key="m" className="mono">{r.model}</span>]}
          />

          <p className="muted usage-note">
            Days are in UTC. A conversation counts on the day it started, including later turns.
            Costs are as reported by Claude Code; subscription use shows the equivalent API cost.
          </p>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="card usage-tile">
      <div className="usage-tile-label">{label}</div>
      <div className="usage-tile-value" title={title}>{value}</div>
    </div>
  );
}

function Breakdown<T extends Numbers>(props: {
  title: string;
  empty: string;
  rows: T[];
  total: number;
  keyOf: (r: T) => string;
  head: string[];
  cells: (r: T) => ReactNode[];
}) {
  const { title, rows, total } = props;
  return (
    <section className="card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted">{props.empty}</p>
      ) : (
        <div className="table-wrap">
          <table className="usage-table">
            <thead>
              <tr>
                {props.head.map((h) => <th key={h} scope="col">{h}</th>)}
                <th scope="col" className="num">Conversations</th>
                <th scope="col" className="num">Input</th>
                <th scope="col" className="num">Output</th>
                <th scope="col" className="num">Cost</th>
                <th scope="col" className="num">Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={props.keyOf(r)}>
                  {props.cells(r).map((c, i) => <td key={i}>{c}</td>)}
                  <td className="num">{whole.format(r.sessions)}</td>
                  <td className="num" title={whole.format(r.inputTokens)}>{compact.format(r.inputTokens)}</td>
                  <td className="num" title={whole.format(r.outputTokens)}>{compact.format(r.outputTokens)}</td>
                  <td className="num">{money(r.costUsd)}</td>
                  <td className="num muted">{total > 0 ? `${Math.round((r.costUsd / total) * 100)}%` : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---- chart ------------------------------------------------------------------------

/** Width of an element, kept current as the layout changes (phone rotation, sidebar). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A round axis maximum and step, so gridlines land on readable amounts. */
function niceScale(max: number, ticks = 4): { top: number; step: number } {
  if (max <= 0) return { top: 1, step: 0.25 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  return { top: Math.ceil(max / step) * step, step };
}

const HEIGHT = 220;
const M = { top: 12, right: 8, bottom: 44, left: 56 };

function CostChart({ days }: { days: UsageReport['byDay'] }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number>();
  const ids = useId();
  const titleId = `${ids}-title`;
  const descId = `${ids}-desc`;

  const total = days.reduce((n, d) => n + d.costUsd, 0);
  const peak = days.reduce<(typeof days)[number] | undefined>((p, d) => (!p || d.costUsd > p.costUsd ? d : p), undefined);
  const { top, step } = niceScale(peak?.costUsd ?? 0);

  const innerW = Math.max(0, width - M.left - M.right);
  const innerH = HEIGHT - M.top - M.bottom;
  const slot = days.length ? innerW / days.length : 0;
  const gap = slot >= 6 ? 2 : slot >= 3 ? 1 : 0;
  const barW = Math.max(1, slot - gap);
  const y = (v: number) => M.top + innerH - (v / top) * innerH;

  const gridValues = useMemo(() => {
    const out: number[] = [];
    for (let v = 0; v <= top + step / 2; v += step) out.push(Number(v.toFixed(6)));
    return out;
  }, [top, step]);

  // First, middle and last day, plus more when there is room (~70px per label).
  const xTicks = useMemo(() => {
    if (!days.length || !innerW) return [];
    const count = Math.max(2, Math.min(days.length, Math.floor(innerW / 70)));
    const idx = new Set<number>();
    for (let i = 0; i < count; i++) idx.add(Math.round((i * (days.length - 1)) / Math.max(1, count - 1)));
    return [...idx];
  }, [days.length, innerW]);

  const summary = days.length
    ? `${money(total)} in total from ${longDay(days[0]!.day)} to ${longDay(days[days.length - 1]!.day)}` +
      (peak && peak.costUsd > 0 ? `; highest ${money(peak.costUsd)} on ${longDay(peak.day)}.` : '; no usage in this range.')
    : 'No days in range.';

  const onPointer = (clientX: number, rect: DOMRect) => {
    if (!slot) return;
    const i = Math.floor((clientX - rect.left - M.left) / slot);
    setHover(i >= 0 && i < days.length ? i : undefined);
  };

  const hovered = hover !== undefined ? days[hover] : undefined;
  const tipLeft = hover !== undefined ? Math.min(Math.max(M.left + (hover + 0.5) * slot, 70), width - 70) : 0;

  return (
    <figure className="usage-chart">
      <div ref={wrapRef} className="usage-chart-plot">
        {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-labelledby={`${titleId} ${descId}`}
            onPointerMove={(e) => onPointer(e.clientX, e.currentTarget.getBoundingClientRect())}
            onPointerDown={(e) => onPointer(e.clientX, e.currentTarget.getBoundingClientRect())}
            onPointerLeave={() => setHover(undefined)}
          >
            <title id={titleId}>Bar chart of cost in US dollars per day (UTC)</title>
            <desc id={descId}>{summary}</desc>

            {/* y gridlines and amounts */}
            {gridValues.map((v) => (
              <g key={v} aria-hidden="true">
                <line className={v === 0 ? 'usage-axis' : 'usage-grid'} x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} />
                <text className="usage-tick" x={M.left - 6} y={y(v)} dy="0.32em" textAnchor="end">{usdAxis.format(v)}</text>
              </g>
            ))}
            <text className="usage-axis-label" aria-hidden="true" transform={`translate(12 ${M.top + innerH / 2}) rotate(-90)`} textAnchor="middle">
              Cost (USD)
            </text>

            {/* hover column */}
            {hover !== undefined && (
              <rect className="usage-hover" x={M.left + hover * slot} y={M.top} width={slot} height={innerH} aria-hidden="true" />
            )}

            {/* bars: rounded data end, square on the baseline */}
            <g aria-hidden="true">
              {days.map((d, i) => {
                if (d.costUsd <= 0) return null;
                const h = Math.max(1, (d.costUsd / top) * innerH);
                const x = M.left + i * slot + gap / 2;
                const r = Math.min(4, barW / 2, h);
                const base = M.top + innerH;
                return (
                  <path
                    key={d.day}
                    className="usage-bar"
                    d={`M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + barW - r} Q${x + barW},${base - h} ${x + barW},${base - h + r} V${base} Z`}
                  />
                );
              })}
            </g>

            {/* x ticks */}
            {xTicks.map((i) => (
              <text
                key={i}
                aria-hidden="true"
                className="usage-tick"
                x={Math.min(Math.max(M.left + (i + 0.5) * slot, M.left + 20), width - M.right - 20)}
                y={M.top + innerH + 16}
                textAnchor="middle"
              >
                {shortDay(days[i]!.day)}
              </text>
            ))}
            <text className="usage-axis-label" aria-hidden="true" x={M.left + innerW / 2} y={HEIGHT - 6} textAnchor="middle">
              Day (UTC)
            </text>
          </svg>
        )}
        {hovered && (
          <div className="usage-tooltip" style={{ left: tipLeft }} aria-hidden="true">
            <strong>{longDay(hovered.day)}</strong>
            <span>{money(hovered.costUsd)}</span>
            <span className="muted">{whole.format(hovered.sessions)} conversation{hovered.sessions === 1 ? '' : 's'}</span>
          </div>
        )}
      </div>
      <figcaption className="muted">{summary}</figcaption>
      <details className="usage-data">
        <summary>Show as a table</summary>
        <div className="table-wrap">
          <table className="usage-table">
            <caption className="usage-sr-only">Cost per day</caption>
            <thead>
              <tr><th scope="col">Day (UTC)</th><th scope="col" className="num">Conversations</th><th scope="col" className="num">Cost</th></tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day}>
                  <td>{longDay(d.day)}</td>
                  <td className="num">{whole.format(d.sessions)}</td>
                  <td className="num">{money(d.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

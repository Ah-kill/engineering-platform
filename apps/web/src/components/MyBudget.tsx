import { useResource } from '../hooks';

/** GET /api/me/budget */
interface MyBudgetStatus {
  limitUsd: number | null;
  spentUsd: number;
  allowed: boolean;
  month: string;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (n: number) => (n > 0 && n < 0.005 ? '<$0.01' : usd.format(n));

/** The signed-in developer's spend this month against their monthly limit. Hidden when there is no limit. */
export function MyBudget() {
  const { data } = useResource<MyBudgetStatus>('/me/budget');
  if (!data || data.limitUsd === null) return null;
  const pct = data.limitUsd > 0 ? Math.min(100, (data.spentUsd / data.limitUsd) * 100) : 100;
  const month = new Date(`${data.month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', timeZone: 'UTC' });
  return (
    <section className="card my-budget" aria-label="Your monthly budget">
      <div className="my-budget-line">
        <span>Your budget for {month}</span>
        <strong>{money(data.spentUsd)} of {money(data.limitUsd)}</strong>
      </div>
      <div className={`budget-meter${data.allowed ? '' : ' over'}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={`${Math.round(pct)}% of your monthly budget used`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      {!data.allowed && <div className="muted my-budget-note">You have reached your limit, so new Claude runs are paused until next month. An org admin can raise it.</div>}
    </section>
  );
}

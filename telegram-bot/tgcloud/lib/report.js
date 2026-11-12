// One-way reporting from the bot to the control plane (collector), used to
// accumulate user stats, usage and chat logs for the admin panel. Best-effort
// and non-blocking — failures are silently swallowed.

export function createReport({ fetchImpl, reportUrl, reportSecret }) {
  return async function report(payload) {
    if (!reportUrl || !reportSecret) return;
    const u = String(reportUrl).replace(/\/+$/, '');
    try {
      const res = await (fetchImpl || fetch)(`${u}/api/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${reportSecret}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        console.warn('[report] control plane returned', res.status);
      }
    } catch (e) {
      console.debug('[report] failed:', String(e?.message || e).slice(0, 120));
    }
  };
}

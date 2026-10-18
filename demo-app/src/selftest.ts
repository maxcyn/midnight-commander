// Verifies the Stage 1 "done when" criteria against a running demo app.
const BASE = `http://localhost:${process.env.PORT ?? 4000}`;
const dev = {
  authorization: `Bearer ${process.env.DEV_TOKEN ?? "change-me"}`,
  "content-type": "application/json",
};
const act = {
  authorization: `Bearer ${process.env.ACTION_TOKEN ?? "change-me"}`,
  "content-type": "application/json",
};
const probe = {
  authorization: `Bearer ${process.env.PROBE_TOKEN ?? "change-me"}`,
};

const post = (path: string, headers: Record<string, string>, body: unknown = {}) =>
  fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
const checkout = () =>
  fetch(BASE + "/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ sku: "sku-tee", qty: 1 }] }),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
const getProbe = (dep: string) => fetch(`${BASE}/probe/${dep}`, { headers: probe }).then((r) => r.json() as Promise<any>);

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + detail}`);
  if (!cond) failures++;
}

await post("/dev/reset", dev);
let r = await checkout();
check("healthy baseline: checkout succeeds", r.status === 200 && !!r.body.orderId, JSON.stringify(r));

await post("/dev/faults", dev, { recommendation: true });
r = await checkout();
check("recommendation fault breaks checkout", r.status === 504 && r.body.stage === "recommendations", JSON.stringify(r));
check("probe: recommendations unhealthy", (await getProbe("recommendations")).healthy === false);
check("probe: payments healthy (independent evidence)", (await getProbe("payments")).healthy === true);

let a = await post("/actions/disable-recommendations", act, { actor: "selftest" });
check("mitigation changes flag", a.changed === true && a.previousValue === true, JSON.stringify(a));
r = await checkout();
check("disabling recommendations restores checkout", r.status === 200 && !!r.body.orderId, JSON.stringify(r));
a = await post("/actions/disable-recommendations", act);
check("mitigation is idempotent on retry", a.changed === false && a.currentValue === false, JSON.stringify(a));

await post("/dev/reset", dev);
await post("/dev/faults", dev, { payment: true });
r = await checkout();
check("payment fault breaks checkout", r.status === 502 && r.body.stage === "payment", JSON.stringify(r));
await post("/actions/disable-recommendations", act);
r = await checkout();
check("same action does NOT repair payment failure", r.status === 502 && r.body.stage === "payment", JSON.stringify(r));
check("probe: payments unhealthy", (await getProbe("payments")).healthy === false);

// Provider degradation: the visible symptom is recommendations, the cause is the payment provider.
await post("/dev/reset", dev);
await post("/dev/faults", dev, { providerDegradation: true });
r = await checkout();
check("provider degradation surfaces as a recommendation timeout (payment never reached)", r.status === 504 && r.body.stage === "recommendations", JSON.stringify(r));
check("probe: recommendations unhealthy under degradation", (await getProbe("recommendations")).healthy === false);
const payProbe = await getProbe("payments");
check("probe: payments still 'healthy' but slow (the only clue)", payProbe.healthy === true && payProbe.latencyMs > 1000, JSON.stringify(payProbe));
await post("/actions/disable-recommendations", act);
r = await checkout();
check("disabling recommendations does NOT fix provider degradation", r.status === 502 && r.body.stage === "payment", JSON.stringify(r));
a = await post("/actions/switch-payment-provider", act, { actor: "selftest", expectedPreviousValue: "primary" });
check("switch action changes provider and records previous value", a.changed === true && a.previousValue === "primary" && a.currentValue === "backup", JSON.stringify(a));
r = await checkout();
check("switching provider restores checkout", r.status === 200 && !!r.body.orderId, JSON.stringify(r));
a = await post("/actions/switch-payment-provider", act, { actor: "selftest" });
check("switch is idempotent, not a toggle", a.changed === false && a.currentValue === "backup", JSON.stringify(a));
const pre = await fetch(BASE + "/actions/switch-payment-provider", { method: "POST", headers: act, body: JSON.stringify({ expectedPreviousValue: "primary" }) });
check("switch refuses when its precondition no longer holds", pre.status === 409);

await post("/dev/reset", dev);
await post("/dev/faults", dev, { providerDegradation: true });
await post("/actions/switch-payment-provider", act);
await post("/dev/reset", dev);
await post("/dev/faults", dev, { recommendation: true });
await post("/actions/switch-payment-provider", act);
r = await checkout();
check("switching provider does NOT fix a genuine recommendation outage", r.status === 504 && r.body.stage === "recommendations", JSON.stringify(r));
await post("/dev/reset", dev);

const noAuth = await fetch(BASE + "/actions/disable-recommendations", { method: "POST" });
check("mitigation rejects missing auth", noAuth.status === 401);
const wrongToken = await fetch(BASE + "/dev/faults", {
  method: "POST",
  headers: { authorization: `Bearer wrong-token` },
});
check("probe token cannot set faults", wrongToken.status === 401);

await post("/dev/reset", dev);
console.log(failures === 0 ? "\nAll Stage 1 checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);

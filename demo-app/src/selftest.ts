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

// scratch (fix61): preload for node tests: moves Date to HEYLOOK_FAKE_NOW, still running
const want = process.env.HEYLOOK_FAKE_NOW ? new Date(process.env.HEYLOOK_FAKE_NOW).getTime() : NaN;
if (!Number.isNaN(want)) {
  const Real = Date, off = want - Real.now();
  function FakeDate(...a) { return new.target ? (a.length ? new Real(...a) : new Real(Real.now() + off)) : new Real(Real.now() + off).toString(); }
  FakeDate.prototype = Real.prototype; FakeDate.UTC = Real.UTC; FakeDate.parse = Real.parse; FakeDate.now = () => Real.now() + off;
  globalThis.Date = FakeDate;
}

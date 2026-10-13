// Checks src/addresses.ts. Run: node --experimental-strip-types scripts/test-addresses.mjs
import assert from "node:assert/strict";
import { isEmail, singleLabelHostsOf } from "../src/addresses.ts";

for (const ok of ["ann@example.com", "a.b+c@mail.example.co.uk", "qa@localhost", "QA@LOCALHOST"]) assert.ok(isEmail(ok), ok);
for (const bad of ["ann", "ann@", "@example.com", "ann@gmail", "ann bob@example.com", "ann@exa mple.com", "<ann@example.com>", ""]) assert.ok(!isEmail(bad), bad);
const hosts = singleLabelHostsOf([{ email: "me@intranet", imapHost: "mailhost", smtpHost: "smtp.example.com" }, { email: "x@example.com" }]);
assert.deepEqual(hosts.sort(), ["intranet", "mailhost"]);
assert.ok(isEmail("boss@intranet", hosts) && isEmail("t@mailhost", hosts));
assert.ok(!isEmail("boss@other", hosts), "only the account's own hosts");
console.log("addresses: all checks passed");

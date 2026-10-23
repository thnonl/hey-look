// The unsubscribe mailto link (D-062 follow-up): the address, the subject token and the body of the link reach the compose window.
import assert from "node:assert/strict";
import { unsubscribeMailto as u } from "../src/unsubscribeMailto.ts";

assert.deepEqual(u("mailto:unsubscribe@em5860.bunny.net?subject=1365094.Ez4Dq46RF7gFBR8c"), { to: "unsubscribe@em5860.bunny.net", subject: "1365094.Ez4Dq46RF7gFBR8c", body: undefined });
assert.deepEqual(u("mailto:u@example.com"), { to: "u@example.com", subject: "unsubscribe", body: undefined });
assert.deepEqual(u("MAILTO:a%40example.com?Subject=Stop%20please&body=Remove%20me%0Athanks"), { to: "a@example.com", subject: "Stop please", body: "Remove me\nthanks" });
assert.equal(u("mailto:a@example.com,b@example.com?subject=x").to, "a@example.com");
assert.equal(u("mailto:a@example.com?subject=%E0%A4%A").subject, "%E0%A4%A", "a broken escape stays as written");
assert.equal(u("mailto:a@example.com?cc=evil@example.net&subject=s").subject, "s");
console.log("test-unsubscribe-mailto: ok");

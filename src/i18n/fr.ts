import common from "./ns/common.ts";
import app from "./ns/app.ts";
import mail from "./ns/mail.ts";
import settings from "./ns/settings.ts";
import compose from "./ns/compose.ts";
import pgp from "./ns/pgp.ts";
import reading from "./ns/reading.ts";
import calendar from "./ns/calendar.ts";
import errors from "./ns/errors.ts";
import updates from "./ns/updates.ts";
import backend from "./ns/backend.ts";
import signin from "./ns/signin.ts";

export const fr = {
  ...common.fr,
  ...app.fr,
  ...mail.fr,
  ...settings.fr,
  ...compose.fr,
  ...pgp.fr,
  ...reading.fr,
  ...calendar.fr,
  ...errors.fr,
  ...updates.fr,
  ...backend.fr,
  ...signin.fr,
};

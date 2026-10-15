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

export const en = {
  ...common.en,
  ...app.en,
  ...mail.en,
  ...settings.en,
  ...compose.en,
  ...pgp.en,
  ...reading.en,
  ...calendar.en,
  ...errors.en,
  ...updates.en,
  ...backend.en,
  ...signin.en,
};

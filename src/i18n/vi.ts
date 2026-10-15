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

export const vi = {
  ...common.vi,
  ...app.vi,
  ...mail.vi,
  ...settings.vi,
  ...compose.vi,
  ...pgp.vi,
  ...reading.vi,
  ...calendar.vi,
  ...errors.vi,
  ...updates.vi,
  ...backend.vi,
};

// Japanese (ja): gathers the files of this folder, one per area. A new area added in src/i18n/ns/ needs a line here.
import type { en } from "../../en.ts";
import type { Msg } from "../../types.ts";
import app from "./app.ts";
import backend from "./backend.ts";
import calendar from "./calendar.ts";
import common from "./common.ts";
import compose from "./compose.ts";
import errors from "./errors.ts";
import mail from "./mail.ts";
import pgp from "./pgp.ts";
import reading from "./reading.ts";
import settings from "./settings.ts";
import signin from "./signin.ts";
import updates from "./updates.ts";

export const ja = {
  ...app,
  ...backend,
  ...calendar,
  ...common,
  ...compose,
  ...errors,
  ...mail,
  ...pgp,
  ...reading,
  ...settings,
  ...signin,
  ...updates,
} satisfies Record<keyof typeof en, Msg>;

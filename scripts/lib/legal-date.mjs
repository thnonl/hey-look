// The one place of the "Last updated" date of the four legal pages (privacy, terms, google-data, security) on the website, in all 8 languages (no dependencies).
// To move the date (for example to the day of the merge):  node scripts/set-legal-date.mjs YYYY-MM-DD   (it rewrites this constant and the 32 pages; test-legal-dates then checks them)
export const LEGAL_DATE = '2026-10-19';

const M = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
};

// per language: [text in front of the date, the date as that language writes it, text after it]; the line is the start of a <p class="lead"> of the page
// (mon = the month's name, for the languages that write it out)
export const LINE = {
  en: ({ y, d, mon }) => ['Last updated: ', `${d} ${mon} ${y}`, '.'],
  vi: ({ y, m, d }) => ['Cập nhật lần cuối: ', `${d} tháng ${m} năm ${y}`, '.'],
  fr: ({ y, d, mon }) => ['Dernière mise à jour&nbsp;: ', `${d} ${mon} ${y}`, '.'],
  zh: ({ y, m, d }) => ['最后更新：', `${y}年${m}月${d}日`, '。'],
  es: ({ y, d, mon }) => ['Última actualización: ', `${d} de ${mon} de ${y}`, '.'],
  ja: ({ y, m, d }) => ['最終更新日：', `${y}年${m}月${d}日`, '。'],
  de: ({ y, d, mon }) => ['Zuletzt aktualisiert: ', `${d}. ${mon} ${y}`, '.'],
  ru: ({ y, d, mon }) => ['Последнее обновление: ', `${d} ${mon} ${y} г`, '.'],
};

export function parts(code, iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`"${iso}" is not a date as YYYY-MM-DD`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) throw new Error(`"${iso}" is not a real day`);
  return LINE[code]({ y, m: mo, d, mon: M[code] ? M[code][mo - 1] : '' });
}
// the whole sentence as it stands in the page, and the regex that finds it (with any date) at the start of a lead paragraph
export const sentence = (code, iso) => parts(code, iso).join('');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const finder = (code) => {
  const [pre, date, post] = LINE[code]({ y: '\u0001Y', m: '\u0001M', d: '\u0001D', mon: '\u0001N' });
  const any = esc(date).replace('\u0001Y', '\\d{4}').replace('\u0001M', '\\d{1,2}').replace('\u0001D', '\\d{1,2}').replace('\u0001N', '[^\\s<\\d]+');
  return new RegExp(`(<p class="lead">)${esc(pre)}${any}${esc(post)}`);
};

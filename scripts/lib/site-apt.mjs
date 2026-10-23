// The "Install with APT" block of the download page (WP15, spec-107-wp15-apt.md section 4.6 and 7.2): the five commands, the file docs/apt/heylook.sources,
// and the texts in the eight languages, as the language specialists agreed them on 2026-10-19. The pages are written by hand; scripts/test-site-apt.mjs
// builds the block from this file and requires every page to contain it, so a page cannot drift from the agreed text (a changed text goes through the
// specialists again, like every text of the website). Nothing here is read at run time by the site.
// fr: U+00A0 (written as &nbsp; in the HTML) stands before ":" and "?"; a sentence that ends with the name "Hey Look!" takes no extra full stop.
export const REPO_URL = "https://heylook.namthai.site/apt";
/** The markers around the block in the source of every download page (DEC-022): build-site.mjs takes everything between them out while the site is dormant. */
export const APT_BEGIN = "<!-- hl:apt-begin -->";
export const APT_END = "<!-- hl:apt-end -->";
/** The texts of the block that must not be on a dormant site (the summary of each language is enough to find it). */
export const SUMMARIES = () => Object.values(TEXTS).map((t) => t.summary);
export const KEYRING_PATH = "/etc/apt/keyrings/heylook-archive-keyring.gpg";
export const SOURCES_PATH = "/etc/apt/sources.list.d/heylook.sources";

/** The five commands, in the order of the page: key, repository, install, check the key, remove. The same on all eight pages. */
export const COMMANDS = [
  `sudo wget -qO ${KEYRING_PATH} ${REPO_URL}/heylook-archive-keyring.gpg`,
  `sudo wget -qO ${SOURCES_PATH} ${REPO_URL}/heylook.sources`,
  "sudo apt update && sudo apt install hey-look",
  `gpg --show-keys ${KEYRING_PATH}`,
  `sudo apt remove hey-look && sudo rm ${SOURCES_PATH} ${KEYRING_PATH}`,
];

/** docs/apt/heylook.sources, byte for byte (deb822; works with apt 1.1 and later). */
export const SOURCES_FILE = [
  "Types: deb",
  `URIs: ${REPO_URL}`,
  "Suites: stable",
  "Components: main",
  "Architectures: amd64",
  `Signed-By: ${KEYRING_PATH}`,
  "",
].join("\n");

/** The UID of the placeholder key that stands in docs/apt until the owner's real key is committed (a tag run must not go with it). */
export const PLACEHOLDER_UID = "Hey Look! APT test (throwaway)";
/** The UID of the real signing key (DEC-001). */
export const REAL_UID = "Hey Look! APT signing <namth.onl@gmail.com>";

const N = " ";

/** keyed by the registry code of the language (en, vi, fr, zh-Hans, es, ja, de, ru); {fingerprint} is replaced by <code>…</code> */
export const TEXTS = {
  en: {
    summary: "Install with APT and get updates with your system",
    lead: "For Ubuntu 22.04 or later and Debian 12 or later, on 64-bit PCs (amd64). Add the Hey Look! repository once: Hey Look! is then updated with the rest of your system, and the app no longer updates itself.",
    step1: "1. Download the signing key of the repository:",
    step2: "2. Add the repository:",
    step3: "3. Install Hey Look!:",
    fingerprint: "The fingerprint of the signing key is {fingerprint}. To compare it with the key you downloaded, run:",
    existing: "Already installed the .deb from this page? Follow the same three steps. Your mail, accounts and settings stay, and updates then come through APT.",
    remove: "To remove Hey Look! and the repository:",
  },
  vi: {
    summary: "Cài bằng APT và nhận cập nhật cùng hệ thống",
    lead: "Dành cho Ubuntu 22.04 trở lên và Debian 12 trở lên, trên máy tính 64-bit (amd64). Chỉ cần thêm kho Hey Look! một lần: sau đó Hey Look! được cập nhật cùng phần còn lại của hệ thống, và ứng dụng không còn tự cập nhật nữa.",
    step1: "1. Tải khóa ký của kho:",
    step2: "2. Thêm kho:",
    step3: "3. Cài đặt Hey Look!:",
    fingerprint: "Vân tay của khóa ký là {fingerprint}. Để so sánh với khóa bạn đã tải, hãy chạy:",
    existing: "Đã cài .deb từ trang này rồi? Hãy làm theo cùng ba bước đó. Thư, tài khoản và cài đặt của bạn vẫn được giữ nguyên, và từ đó các bản cập nhật sẽ đến qua APT.",
    remove: "Để gỡ cài đặt Hey Look! và kho:",
  },
  fr: {
    summary: "Installer avec APT, mises à jour avec le système",
    lead: `Pour Ubuntu 22.04 ou version ultérieure et Debian 12 ou version ultérieure, sur PC 64 bits (amd64). Ajoutez le dépôt de Hey Look! une seule fois${N}: Hey Look! sera alors mis à jour avec le reste de votre système, et l’application ne se met plus à jour toute seule.`,
    step1: `1. Téléchargez la clé de signature du dépôt${N}:`,
    step2: `2. Ajoutez le dépôt${N}:`,
    step3: `3. Installez Hey Look!${N}:`,
    fingerprint: `L’empreinte de la clé de signature est {fingerprint}. Pour la comparer à la clé que vous avez téléchargée, exécutez${N}:`,
    existing: `Vous avez déjà installé le .deb de cette page${N}? Suivez les mêmes trois étapes. Vos e-mails, comptes et paramètres sont conservés, et les mises à jour passent ensuite par APT.`,
    remove: `Pour supprimer Hey Look! et le dépôt${N}:`,
  },
  "zh-Hans": {
    summary: "通过APT安装，随系统一起更新",
    lead: "适用于Ubuntu 22.04或更高版本、Debian 12或更高版本的64位电脑（amd64）。只需添加一次Hey Look!软件源，Hey Look!就会和系统的其他软件一起更新，应用不再自行更新。",
    step1: "1. 下载软件源的签名密钥：",
    step2: "2. 添加软件源：",
    step3: "3. 安装Hey Look!：",
    fingerprint: "签名密钥的指纹是{fingerprint}。要将其与您下载的密钥比对，请运行：",
    existing: "已经安装了本页的.deb？照样执行这三个步骤即可。您的邮件、账户和设置都会保留，此后更新将通过APT提供。",
    remove: "要删除Hey Look!和软件源，请运行：",
  },
  es: {
    summary: "Instalar con APT y actualizar con el sistema",
    lead: "Para Ubuntu 22.04 o posterior y Debian 12 o posterior, en PC de 64 bits (amd64). Añade el repositorio de Hey Look! una sola vez: Hey Look! se actualizará junto con el resto del sistema y la aplicación dejará de actualizarse por sí sola.",
    step1: "1. Descarga la clave de firma del repositorio:",
    step2: "2. Añade el repositorio:",
    step3: "3. Instala Hey Look!:",
    fingerprint: "La huella digital de la clave de firma es {fingerprint}. Para compararla con la clave que descargaste, ejecuta:",
    existing: "¿Ya instalaste el .deb de esta página? Sigue los mismos tres pasos. Tu correo, tus cuentas y tu configuración se conservan, y las actualizaciones llegarán después por APT.",
    remove: "Para desinstalar Hey Look! y el repositorio:",
  },
  ja: {
    summary: "APTでインストール、更新はシステムで",
    lead: "Ubuntu 22.04以降とDebian 12以降の64ビットPC（amd64）向けです。Hey Look!のリポジトリを一度追加すると、Hey Look!はシステムの他のソフトウェアと一緒にアップデートされ、アプリ自身ではアップデートしなくなります。",
    step1: "1. リポジトリの署名鍵をダウンロードします：",
    step2: "2. リポジトリを追加します：",
    step3: "3. Hey Look!をインストールします：",
    fingerprint: "署名鍵のフィンガープリントは{fingerprint}です。ダウンロードした鍵と照合するには、次のコマンドを実行してください。",
    existing: "このページの.debをインストール済みですか？同じ3つの手順を行ってください。メール、アカウント、設定はそのまま残り、以後のアップデートはAPTで届きます。",
    remove: "Hey Look!とリポジトリを削除するには：",
  },
  de: {
    summary: "Mit APT installieren und mit dem System aktualisieren",
    lead: "Für Ubuntu 22.04 oder neuer und Debian 12 oder neuer, auf 64-Bit-PCs (amd64). Fügen Sie das Hey-Look!-Repository einmal hinzu: Hey Look! wird dann zusammen mit dem Rest Ihres Systems aktualisiert, und die App aktualisiert sich nicht mehr selbst.",
    step1: "1. Signaturschlüssel des Repositorys herunterladen:",
    step2: "2. Repository hinzufügen:",
    step3: "3. Hey Look! installieren:",
    fingerprint: "Der Fingerabdruck des Signaturschlüssels lautet {fingerprint}. Um ihn mit dem heruntergeladenen Schlüssel zu vergleichen, führen Sie Folgendes aus:",
    existing: "Haben Sie die .deb-Datei von dieser Seite schon installiert? Führen Sie dieselben drei Schritte aus. Ihre E-Mails, Konten und Einstellungen bleiben erhalten, und Updates kommen dann über APT.",
    remove: "So entfernen Sie Hey Look! und das Repository:",
  },
  ru: {
    summary: "Установка через APT: обновления с системой",
    lead: "Для Ubuntu 22.04 и новее и Debian 12 и новее, на 64-разрядных ПК (amd64). Добавьте репозиторий Hey Look! один раз: после этого Hey Look! будет обновляться вместе с остальной системой, а само приложение перестанет обновляться самостоятельно.",
    step1: "1. Скачайте ключ подписи репозитория:",
    step2: "2. Добавьте репозиторий:",
    step3: "3. Установите приложение:",
    fingerprint: "Отпечаток ключа подписи: {fingerprint}. Чтобы сверить его со скачанным ключом, выполните:",
    existing: "Уже установили .deb с этой страницы? Выполните те же три шага. Ваша почта, учётные записи и настройки сохранятся, а обновления будут приходить через APT.",
    remove: "Чтобы удалить Hey Look! и репозиторий:",
  },
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/ /g, "&nbsp;");

/** The fingerprint (40 hex digits) in groups of four, as the page shows it: "6A60 BC4B ...". */
export const groupFingerprint = (fpr) => fpr.replace(/\s+/g, "").toUpperCase().replace(/(.{4})(?=.)/g, "$1 ");

/** One copy box, the same markup as the macOS box (docs/download.html): the code and the button with the language's own "Copy". */
const box = (cmd, copy) => `<div class="copy"><code>${esc(cmd)}</code><button class="btn btn-ghost btn-sm" type="button">${esc(copy)}</button></div>`;

/** The whole block of the Linux card (markers, <details id="apt">), one element per line (8 spaces of indent inside the card, like the neighbours). */
export function aptBlock(lang, fingerprint, copy) {
  const t = TEXTS[lang];
  const [fp] = t.fingerprint.split("{fingerprint}");
  const rest = t.fingerprint.slice(fp.length + "{fingerprint}".length);
  return [
    `      ${APT_BEGIN}<details id="apt"><summary>${esc(t.summary)}</summary>`,
    `        <p>${esc(t.lead)}</p>`,
    `        <p>${esc(t.step1)}</p>`,
    `        ${box(COMMANDS[0], copy)}`,
    `        <p>${esc(t.step2)}</p>`,
    `        ${box(COMMANDS[1], copy)}`,
    `        <p>${esc(t.step3)}</p>`,
    `        ${box(COMMANDS[2], copy)}`,
    `        <p>${esc(fp)}<code>${esc(groupFingerprint(fingerprint))}</code>${esc(rest)}</p>`,
    `        ${box(COMMANDS[3], copy)}`,
    `        <p>${esc(t.existing)}</p>`,
    `        <p>${esc(t.remove)}</p>`,
    `        ${box(COMMANDS[4], copy)}</details>${APT_END}`,
  ].join("\n");
}

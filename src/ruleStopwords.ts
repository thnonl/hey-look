// Words that are never offered as "Suggested words" in the rule dialog (src/ruleSuggest.ts): the common words of the 8 languages of the app, and the boilerplate of
// automatic mail in any language ("unsubscribe", "view in browser", "regards"...). One flat set: a word is a stop word in every language (a mail is often written in a
// language other than the app's). Lower case, NFKC; words of fewer than 3 letters (2 for Han / Kana / Hangul) never reach the check. Part of the rule dialog's own chunk.

const EN =
  "the and for are but not you your yours our ours was were been being have has had having this that these those with from they them their there here what when where which who whom whose why how " +
  "will would could should can may might must shall about above after again all also any because before below between both down during each few further into just more most other out over own " +
  "same some such than then too very off only once under until while through against within without upon per via get got let its itself ourselves yourself yourselves himself herself themselves " +
  "his her him she did does doing done say said says see seen use used using one two new now yes " +
  "dear hello hi hey regards thanks thank sincerely best kind cheers greetings team please sent sends send reply replies forward forwarded wrote writes " +
  "email emails mail mails message messages click clicking link links button here unsubscribe unsubscribed subscription subscribe preferences preference settings view browser online web version " +
  "privacy policy terms conditions rights reserved copyright address inc ltd llc corp company confidential disclaimer notification notifications automated automatic noreply reply attached attachment " +
  "free offer offers sale deal deals today tomorrow monday tuesday wednesday thursday friday saturday sunday january february march april june july august september october november december";

const VI =
  "và của là có không được cho các này trong khi với một những cũng đã sẽ để từ như thì mà hay hoặc nhưng nếu vì nên rất lại ra vào lên xuống đến tại theo về sau trước đây đó kia nào gì ai sao " +
  "tôi bạn anh chị em ông bà chúng ta họ mình xin chào cảm ơn trân trọng kính gửi thân mến vui lòng lòng thư email nhấn bấm liên kết đường dẫn hủy đăng ký xem trình duyệt phiên bản " +
  "bảo mật chính sách điều khoản quyền riêng tư địa chỉ công ty thông báo tự động đính kèm trả lời chuyển tiếp";

const FR =
  "le la les un une des du de et ou mais donc car ni que qui quoi dont où ce cet cette ces mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs je tu il elle on nous vous ils elles " +
  "est sont était été être avoir avait ont pas ne plus moins très aussi comme pour par sur sous dans avec sans chez vers entre contre depuis pendant avant après alors ainsi encore déjà " +
  "bonjour bonsoir salut cordialement merci cher chère madame monsieur équipe veuillez cliquez cliquer ici lien bouton courriel message messages désabonner désinscrire abonnement préférences " +
  "navigateur version confidentialité politique conditions droits réservés adresse société notification automatique pièce jointe répondre transférer";

const ES =
  "el la los las un una unos unas de del al y o pero que quien cual cuando donde como porque pues si no ni se su sus mi mis tu tus nuestro nuestra nuestros nuestras vuestro lo le les me te nos os " +
  "yo tú él ella nosotros ustedes ellos ellas es son era fue ser estar está están han hay muy más menos también para por con sin sobre entre desde hasta hacia durante antes después ya aún " +
  "hola buenos días buenas tardes saludos cordiales atentamente gracias estimado estimada equipo favor haga clic enlace botón correo mensaje mensajes cancelar suscripción preferencias " +
  "navegador versión privacidad política condiciones derechos reservados dirección empresa notificación automático adjunto responder reenviar";

const DE =
  "der die das den dem des ein eine einen einem einer eines und oder aber denn doch weil dass daß wenn als wie wo was wer wen wem wessen welche welcher welches ich du er sie es wir ihr mich dich " +
  "sich uns euch mein dein sein unser euer ihre ihrer ihnen ist sind war waren wird werden wurde wurden hat haben hatte hatten kann können muss müssen soll sollen nicht kein keine auch noch nur " +
  "schon sehr mehr bei mit nach von vor aus auf für gegen ohne über unter zwischen durch bis seit während hallo guten tag morgen abend liebe lieber sehr geehrte geehrter grüße gruß freundliche " +
  "danke vielen dank bitte klicken klicken sie hier link schaltfläche nachricht nachrichten abbestellen abmelden newsletter abonnement einstellungen browser version datenschutz " +
  "richtlinie bedingungen rechte vorbehalten adresse firma benachrichtigung automatisch anhang antworten weiterleiten";

const RU =
  "и в во не на я с со что он она оно они мы вы как а то все всё так его её ее их но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть " +
  "был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому " +
  "этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая " +
  "здравствуйте привет добрый день вечер уважаемый уважаемая с уважением спасибо благодарим команда пожалуйста нажмите нажать здесь ссылка кнопка письмо письма сообщение сообщения отписаться " +
  "подписка настройки браузер версия конфиденциальность политика условия права защищены адрес компания уведомление автоматическое вложение ответить переслать";

const ZH =
  "我们 你们 他们 她们 它们 自己 这个 那个 这些 那些 这里 那里 什么 怎么 为什么 因为 所以 但是 而且 或者 如果 可以 已经 没有 不是 就是 还是 通过 进行 以及 对于 关于 根据 您好 你好 " +
  "亲爱的 尊敬的 谢谢 感谢 此致 敬礼 顺祝 团队 请点击 点击 此处 链接 按钮 邮件 消息 退订 取消订阅 订阅 偏好 设置 浏览器 版本 隐私 政策 条款 版权 所有 地址 公司 通知 自动 附件 回复 转发 查看 在线";

const JA =
  "これ それ あれ どれ この その あの どの ここ そこ あそこ どこ です ます でした ました ください くださ いただ ありがとう よろしく お願い いたします お世話 になって おり ます こと もの ため よう など また そして しかし ただし " +
  "さん 様 から まで より について による として ので のに ところ という といった しかし もし あり ない ある いる する される できる 株式会社 チーム メール メッセージ クリック こちら リンク ボタン " +
  "配信停止 登録解除 購読 設定 ブラウザ バージョン プライバシー ポリシー 利用規約 著作権 住所 会社 通知 自動 添付 返信 転送 表示 オンライン";

const ALL = [EN, VI, FR, ES, DE, RU, ZH, JA].join(" ");

/** The stop words, lower case and NFKC. */
export const STOP_WORDS: ReadonlySet<string> = new Set(ALL.split(/\s+/).filter(Boolean).map((w) => w.normalize("NFKC").toLowerCase()));

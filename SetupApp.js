/**
 * SetupApp.gs — 初期設定 Web App。
 * doGet() で Setup.html を返し、フォームから時間割・科目・キーワード等を受け取って
 * 各自の Drive に基底フォルダ「ログらく」一式（_inbox + 科目フォルダ）と lograku.md を生成し、
 * 各自所有の30分毎トリガーを登録する。getCurrentConfig() で既存設定をフォームへ読み戻せる。
 */

/** Web アプリのエントリポイント。設定フォーム(Setup.html)を返す。 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Setup')
    .setTitle('ログらく 初期設定')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// 曜日 → 曜日番号（月=1 … 日=7）。フォルダ名「曜日番号＋時限」の2桁コードに使う。
var DAY_TO_NUM = { '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6, '日': 7 };

/**
 * 曜日・時限から保存先フォルダ名（2桁コード）を作る。例: 月1限→"11", 火3限→"23"。
 * 曜日が未知、または時限が1桁でないと null（呼び出し側でスキップ）。
 * @param {string} day 曜日（「月」等）
 * @param {string|number} period 時限（1〜9想定）
 * @return {string|null} 2桁コード または null
 */
function slotFolderCode(day, period) {
  var dn = DAY_TO_NUM[(day || '').trim()];
  var pn = parseInt(String(period == null ? '' : period).replace(/[^0-9]/g, ''), 10);
  if (!dn || !pn || pn < 1 || pn > 9) return null;
  return String(dn) + String(pn);
}

/**
 * フォーム送信を受けて基底フォルダ一式と lograku.md を作成する。
 * 訪問者ごとに実行され、各自の Drive に「ログらく」一式を作り、
 * 各自所有の30分毎トリガーを登録する（手動 installTrigger 不要）。
 * @param {Object} form {
 *   rows: [{day, period, subject}],            // 時間割（科目はここから一覧化）
 *   keywords: { '科目名': 'キーワード文字列' }, // 任意。各科目の分類ヒント
 *   minutesGuide: string,                       // 任意。議事録の書き方（共通既定）
 *   namingRule: string,                         // 任意。ファイル名の付け方（共通既定）
 *   overrides: { '科目名': { minutes, naming } },// 任意。科目別の上書き
 *   geminiKey: string                           // 任意。各自の Gemini API キー（空ならオーナー共有キー）
 * }
 * @return {Object} {baseUrl, baseName, folders:[{name,url}], configUrl, triggerInstalled, message}
 */
function setupWorkspace(form) {
  form = form || {};
  var rows = form.rows || [];

  // 1) 時間割行から科目の一覧（出現順・重複排除）を作る
  var subjectOrder = [];
  for (var i = 0; i < rows.length; i++) {
    var subj = (rows[i].subject || '').trim();
    if (subj && subjectOrder.indexOf(subj) < 0) subjectOrder.push(subj);
  }
  if (subjectOrder.length === 0) {
    throw new Error('科目が1つも入力されていません。時間割を1行以上入れてください。');
  }

  // 2) 各スロット（曜日×時限）→ 2桁フォルダコード を作る。
  //    同一科目が複数コマある場合、その科目には最初に出たコマの2桁コードを割り当てる。
  //    （分類は「科目→1フォルダ」のため、1科目1フォルダに正規化する）
  var slotCodes = [];          // 全スロットの2桁コード（フォルダ作成用、重複排除）
  var slotLabel = {};          // code -> "月1限" のような人間向けラベル
  var subjectFolders = {};     // subjectName -> 2桁コード（分類の保存先）
  for (var r = 0; r < rows.length; r++) {
    var day = (rows[r].day || '').trim();
    var period = (rows[r].period == null ? '' : rows[r].period).toString().trim();
    var subj2 = (rows[r].subject || '').trim();
    if (!day || !subj2) continue;
    var code = slotFolderCode(day, period);
    if (!code) continue;
    if (slotCodes.indexOf(code) < 0) {
      slotCodes.push(code);
      slotLabel[code] = day + period + '限';
    }
    // 科目→フォルダは最初に出たコマを採用
    if (!subjectFolders[subj2]) subjectFolders[subj2] = code;
  }

  // 科目に対応するコードが1つも取れなかった場合（曜日/時限が不正）はエラー
  var mappedCount = 0;
  for (var sName in subjectFolders) {
    if (subjectFolders.hasOwnProperty(sName)) mappedCount++;
  }
  if (mappedCount === 0) {
    throw new Error('曜日・時限から保存先フォルダ（2桁コード）を作れませんでした。曜日（月〜日）と時限（1〜9）を確認してください。');
  }

  // 3) 基底フォルダ + _inbox + 各科目フォルダ「2桁コード_科目名」を作成（例: 11_経営学）
  var base = getBaseFolder(true);
  var createdFolders = [];

  var inbox = getInboxFolder(base);
  createdFolders.push({ name: INBOX_FOLDER_NAME, url: inbox.getUrl() });

  // 科目ごとに1フォルダ。フォルダ名は「2桁コード_科目名」。同じ科目が複数コマでも最初のコマのコードを使う。
  for (var k = 0; k < subjectOrder.length; k++) {
    var subjName = subjectOrder[k];
    var subjCode = subjectFolders[subjName];
    if (!subjCode) continue; // 曜日/時限不正でコードが取れなかった科目はスキップ
    var fname = subjCode + '_' + subjName;
    var folder = findOrCreateFolder(base, fname);
    createdFolders.push({ name: fname, url: folder.getUrl() });
  }

  // 4) lograku.md を生成して基底直下に保存
  var md = buildConfigMarkdown(rows, subjectOrder, subjectFolders, slotLabel, form);
  var configFile = writeConfigDoc(base, md);

  // 5) 各自の Gemini キーが入力されていれば UserProperties に保存（訪問者ごと）
  var geminiKey = (form.geminiKey == null ? '' : String(form.geminiKey)).trim();
  if (geminiKey) {
    PropertiesService.getUserProperties().setProperty('GEMINI_API_KEY', geminiKey);
  }

  // 6) この訪問者の30分毎トリガーを登録（各自所有）。失敗してもフォルダ作成は成功扱い。
  var triggerInstalled = false;
  try {
    installTrigger();
    triggerInstalled = true;
  } catch (e) {
    triggerInstalled = false;
  }

  return {
    baseUrl: base.getUrl(),
    baseName: BASE_FOLDER_NAME,
    folders: createdFolders,
    configUrl: configFile.getUrl(),
    triggerInstalled: triggerInstalled,
    message: '基底フォルダ「' + BASE_FOLDER_NAME + '」と ' + createdFolders.length + ' 個のフォルダ、' + CONFIG_FILE_NAME + ' を作成し、自動処理ON（30分毎トリガー）を設定しました。'
  };
}

/**
 * フォーム内容を lograku.md（既存フォーマット）に組み立てる。
 * @param {Array} rows 時間割行
 * @param {Array} subjectOrder 科目名（出現順・重複排除）
 * @param {Object} subjectFolders 科目名 -> 2桁フォルダコード
 * @param {Object} slotLabel 2桁コード -> "月1限" のラベル
 * @param {Object} form フォーム全体
 */
function buildConfigMarkdown(rows, subjectOrder, subjectFolders, slotLabel, form) {
  var out = [];

  // # 私の時間割
  out.push('# 私の時間割');
  out.push('| 曜日 | 時限 | 科目 |');
  out.push('|----|----|----|');
  for (var i = 0; i < rows.length; i++) {
    var day = (rows[i].day || '').trim();
    var period = (rows[i].period || '').toString().trim();
    var subject = (rows[i].subject || '').trim();
    if (!day || !subject) continue;
    out.push('| ' + day + ' | ' + period + ' | ' + subject + ' |');
  }
  out.push('');

  // # 科目と保存先フォルダ（フォルダ名は「2桁コード_科目名」。コード=曜日番号＋時限）
  // 曜日番号: 月=1 火=2 水=3 木=4 金=5 土=6 日=7。例: 月1限の経営学→11_経営学。
  out.push('# 科目と保存先フォルダ');
  out.push('<!-- フォルダ名は「2桁コード_科目名」（コード=曜日×時限／月=1…日=7／例: 11_経営学=月1限の経営学） -->');
  for (var s = 0; s < subjectOrder.length; s++) {
    var code = subjectFolders[subjectOrder[s]];
    if (!code) continue; // 曜日/時限不正でコードが取れなかった科目はスキップ
    var folderName = code + '_' + subjectOrder[s];
    var label = slotLabel[code] ? '  # ' + code + '=' + slotLabel[code] : '';
    out.push('- ' + subjectOrder[s] + ': ' + folderName + label);
  }
  out.push('');

  // # 分類のヒント（キーワードが入っている科目のみ）
  var keywords = form.keywords || {};
  var hintLines = [];
  for (var h = 0; h < subjectOrder.length; h++) {
    var name = subjectOrder[h];
    var kw = (keywords[name] || '').trim();
    if (kw) hintLines.push('- ' + name + 'は「' + kw + '」の話');
  }
  if (hintLines.length > 0) {
    out.push('# 分類のヒント');
    for (var hi = 0; hi < hintLines.length; hi++) out.push(hintLines[hi]);
    out.push('');
  }

  // # ファイル名のつけ方
  out.push('# ファイル名のつけ方');
  var naming = (form.namingRule || '').trim();
  if (naming) {
    out.push('- ' + naming);
  } else {
    out.push('- 「日付_科目_内容」の順。例: 2026-06-17_物理_運動方程式');
  }
  out.push('');

  // # 議事録の書き方
  out.push('# 議事録の書き方');
  var guide = (form.minutesGuide || '').trim();
  if (guide) {
    out.push('- ' + guide);
  } else {
    out.push('- 授業の復習用。①今日の要点 3〜5個 ②重要用語とその意味 ③テストに出そうな確認問題3問');
    out.push('- だ・である調。約1000字。');
  }
  out.push('');

  // # 科目別の上書き（任意）
  // 各科目の見出しを用意し、フォームの overrides で中身を埋める（空ならプレースホルダのまま）。
  // ユーザーは後で Drive 上の lograku.md を編集して差し替えることもできる。
  out.push('# 科目別の上書き（任意）');
  out.push('<!-- 埋めた科目だけ共通既定を上書きします。空欄なら「# 議事録の書き方」「# ファイル名のつけ方」を使います。 -->');
  for (var so = 0; so < subjectOrder.length; so++) {
    var name2 = subjectOrder[so];
    var ov = (form.overrides && form.overrides[name2]) || {};
    out.push('## ' + name2);
    out.push('- 議事録: ' + ((ov.minutes || '').toString().trim()));
    out.push('- 命名: ' + ((ov.naming || '').toString().trim()));
  }
  out.push('');

  // # 出力先・通知
  out.push('# 出力先・通知');
  out.push('- 保存: Google Drive（上の科目フォルダ）');
  out.push('- 通知: Discord（Script Property DISCORD_WEBHOOK_URL を設定すると有効）');
  out.push('');

  // # 詳細設定
  out.push('# 詳細設定');
  out.push('- minConfidence: 0.6');
  out.push('- timeMatchWeight: 0.5');
  out.push('- useTimeMatch: true');
  out.push('- minTranscriptChars: 300');
  out.push('');

  return out.join('\n');
}

/**
 * 各行の行頭バレット（"- " "* "）を剥がしてtrimし、空行を除いて返す。
 * @param {string} text 複数行テキスト
 * @return {Array<string>} 整形済み行の配列
 */
function stripBulletLines(text) {
  var lines = String(text == null ? '' : text).split(/\r?\n/);
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i].replace(/^\s*[-*]\s+/, '').trim();
    if (ln) out.push(ln);
  }
  return out;
}

/**
 * 既存の lograku.md を読み込み、設定フォーム(Setup.html)用に構造化して返す。
 * 読み取り専用（フォルダや設定の作成・変更はしない）。
 * 基底フォルダや lograku.md が無い、または解析に失敗した場合は exists:false の既定を返す。
 * @return {Object} {
 *   exists, rows:[{day, period, subject}], keywords:{科目名:'kw・kw'},
 *   minutesGuide, namingRule, overrides:{科目名:{minutes, naming}}, hasUserKey
 * }
 */
function getCurrentConfig() {
  var result = {
    exists: false,
    rows: [],
    keywords: {},
    minutesGuide: '',
    namingRule: '',
    overrides: {},
    hasUserKey: false
  };

  // 各自の Gemini キーが UserProperties に保存済みか（値は返さない）
  try {
    var key = PropertiesService.getUserProperties().getProperty('GEMINI_API_KEY');
    result.hasUserKey = !!(key && String(key).trim());
  } catch (e) {
    result.hasUserKey = false;
  }

  var base = getBaseFolder(false);
  if (!base) return result;

  var cfg;
  try {
    cfg = loadConfig(base);
  } catch (e) {
    // lograku.md が無い等。フォームは初期2行で出すため既定のまま返す。
    return result;
  }

  result.exists = true;

  // 時間割（schedule が空なら rows は空のまま）
  var schedule = (cfg.timetable && cfg.timetable.schedule) || [];
  for (var i = 0; i < schedule.length; i++) {
    var e = schedule[i];
    result.rows.push({
      day: e.day,
      period: String(e.period == null ? '' : e.period),
      subject: e.subject
    });
  }

  // 科目別: キーワード / 上書き
  var subjects = (cfg.timetable && cfg.timetable.subjects) || [];
  for (var s = 0; s < subjects.length; s++) {
    var sub = subjects[s];
    var kws = sub.keywords || [];
    if (kws.length > 0) {
      result.keywords[sub.name] = kws.join('・');
    }
    var minutes = (sub.minutesOverride || '').toString().trim();
    var naming = (sub.namingOverride || '').toString().trim();
    if (minutes || naming) {
      result.overrides[sub.name] = { minutes: minutes, naming: naming };
    }
  }

  // 共通既定（行頭バレットを剥がして整形）
  result.minutesGuide = stripBulletLines(cfg.minutesGuide).join('\n');
  result.namingRule = stripBulletLines(cfg.namingRule).join(' ');

  return result;
}

/**
 * 設定済みユーザー向け: いま _inbox を1回処理する（30分待たずに即実行）。
 * 訪問者の権限で動くため、各自の Drive の _inbox を処理する。
 * @return {Object} {processed, skipped, total}
 */
function runNow() {
  return classifyInbox();
}

/**
 * 設定済みユーザー向け: 自動処理（時間トリガー）を止める＝アンインストール。
 * フォルダや設定ファイル(lograku.md)は消さない。再開するには時間割を保存し直す。
 * 訪問者の権限で動くため、各自所有のトリガーだけを削除する。
 * @return {Object} {stopped:true}
 */
function stopAutomation() {
  removeTriggers();
  return { stopped: true };
}

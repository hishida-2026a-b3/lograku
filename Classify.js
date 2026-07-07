/**
 * Classify.gs — ログらく本体の処理パイプライン（GAS版）。
 * _inbox の未処理ファイルを 1件ずつ:
 *   ① 文字起こし（テキストはそのまま / 音声は Gemini inline_data）
 *   ② 録音時刻 × 時間割でコマ推定
 *   ③ Gemini で「分類 + 議事録 + 命名」を JSON 取得（brain.gemini プロンプト移植）
 *   ④ 議事録を Google ドキュメントで作成し科目フォルダへ移動
 *   ⑤ 元ファイルを _done へ移動（冪等）＋ Discord/Logger 通知
 * confidence < minConfidence もしくは文字起こしが短すぎる場合は _要確認 へ退避。
 */

// 拡張子 → 音声 MIME
var AUDIO_MIME = {
  'mp3': 'audio/mp3',
  'm4a': 'audio/mp4',
  'mp4': 'audio/mp4',
  'wav': 'audio/wav',
  'aac': 'audio/aac',
  'ogg': 'audio/ogg',
  'flac': 'audio/flac',
  'webm': 'audio/webm'
};

/**
 * _inbox の未処理ファイルをすべて処理するメイン関数。
 * 時間トリガー（installTrigger）からも、手動実行からも呼べる。
 */
function classifyInbox() {
  var base = getBaseFolder(true);
  var cfg = loadConfig(base);
  var items = listInboxFiles(base);
  var doneFolder = getDoneFolder(base);

  if (items.length === 0) {
    Logger.log('ログらく: _inbox に未処理ファイルはありません。');
    return { processed: 0, skipped: 0, tidied: 0, total: 0, errors: [] };
  }

  var processed = 0;
  var skipped = 0;
  var tidied = 0;
  var errors = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var file = item.file;
    try {
      if (isAlreadyProcessed(file.getId())) {
        // 記録済みだがまだ _inbox にある → _done へ片付けるだけ
        moveSidecarIfAny(file, item.kind, base, doneFolder);
        moveTo(file, doneFolder);
        tidied++;
        continue;
      }
      var result = processOneFile(file, item.kind, cfg, base);
      if (result == null) {
        skipped++;
        continue; // スキップ（長尺音声など）。_inbox に残す。
      }
      markProcessed(file.getId());
      moveSidecarIfAny(file, item.kind, base, doneFolder);
      moveTo(file, doneFolder);
      notifyResult(result);
      processed++;
    } catch (err) {
      var emsg = (err && err.message ? err.message : String(err));
      Logger.log('ログらく: ファイル「' + item.name + '」の処理でエラー: ' + emsg);
      errors.push(item.name + ': ' + emsg);
      // エラーファイルは _inbox に残す（次回再試行）。冪等記録はしない。
    }
  }
  Logger.log('ログらく: 処理 ' + processed + ' 件 / 片付け ' + tidied + ' 件 / スキップ ' + skipped + ' 件 / 失敗 ' + errors.length + ' 件 / 入力 ' + items.length + ' 件。');
  return { processed: processed, skipped: skipped, tidied: tidied, total: items.length, errors: errors };
}

/**
 * 1ファイルを処理する。
 * @return {Object|null} 処理結果 {subject, folder, confidence, reason, filename, title, heldForReview, docUrl, destFolderName}。
 *                       スキップ時は null。
 */
function processOneFile(file, kind, cfg, base) {
  var capturedAt = capturedAtOf(file);

  // ① 文字起こし / 本文取得
  var transcript;
  if (kind === 'text') {
    transcript = fileText(file).trim();
  } else {
    var audioBase = baseOf(file.getName());
    var sidecar = findTranscriptSidecar(base, audioBase);
    if (sidecar) {
      // 既に文字起こし済み（中間ファイルあり）→ 再文字起こしせず再開
      transcript = fileText(sidecar).trim();
    } else {
      transcript = transcribeAudio(file);
      // 直後に永続化（振り分けが落ちても次回は文字起こしをスキップして再開できる）
      if (transcript) writeTranscriptSidecar(base, audioBase, transcript);
    }
  }

  if (!transcript) {
    throw new Error('文字起こし結果が空です（' + file.getName() + '）。');
  }

  // 文字起こしが短すぎる → 要確認へ退避（分類はするが信頼度を強制的に下げ扱い）
  var tooShort = transcript.length < (cfg.params.minTranscriptChars || 300);

  // ② 録音時刻 × 時間割
  var tm = cfg.params.useTimeMatch ? matchSchedule(capturedAt, cfg.timetable.schedule) : null;

  // ③ Gemini で分類 + 議事録 + 命名
  var analysis = analyzeWithGemini(transcript, capturedAt, tm, cfg);

  // 退避判定
  var heldForReview = tooShort || analysis.confidence < (cfg.params.minConfidence || 0.6);

  // ④ 保存先フォルダ決定
  var destFolder;
  var destFolderName;
  if (heldForReview) {
    destFolderName = cfg.params.reviewFolder || '_要確認';
    destFolder = findOrCreateFolder(base, destFolderName);
  } else {
    destFolderName = analysis.folder || '_未分類';
    destFolder = findOrCreateFolder(base, destFolderName);
  }

  // ④ 議事録を Google ドキュメントで作成 → 科目フォルダへ移動
  var docUrl = createMinutesDoc(analysis, destFolder);

  return {
    subject: analysis.subject,
    folder: destFolderName,
    confidence: analysis.confidence,
    reason: analysis.reason,
    filename: analysis.filename,
    title: analysis.title,
    heldForReview: heldForReview,
    docUrl: docUrl,
    destFolderName: destFolderName
  };
}

/**
 * 音声を Gemini に渡して文字起こし（Files API 経由・長尺対応）。
 * inline_data の20MB制限を回避するため、一旦 Files API へアップロードして file_data で参照する。
 * @return {string}
 */
function transcribeAudio(file) {
  var ext = extOf(file.getName());
  var mime = AUDIO_MIME[ext] || 'audio/mp4';
  var uploaded = geminiUploadFile(file.getBlob(), mime, file.getName(), file.getSize());
  var text = geminiGenerate([
    { file_data: { mime_type: uploaded.mimeType || mime, file_uri: uploaded.uri } },
    { text: 'この音声は日本語の大学の授業です。話者の発話を句読点付きで正確に文字起こししてください。前後の解説や要約は不要、本文のみ。' }
  ], { json: false });
  return String(text).trim();
}

/**
 * 完了した音声に対応する文字起こしサイドカー(<base>.ja.txt)があれば _done へ移す。
 * 孤児サイドカーが新規テキスト入力に誤認されないよう、必ず音声本体より先に呼ぶこと。
 */
function moveSidecarIfAny(file, kind, base, doneFolder) {
  if (kind !== 'audio') return;
  var sidecar = findTranscriptSidecar(base, baseOf(file.getName()));
  if (sidecar) moveTo(sidecar, doneFolder);
}

/**
 * Gemini で「分類 + 議事録 + 命名」を JSON 取得（brain.gemini.ts プロンプト移植）。
 * 分類で確定した科目に「科目別の上書き」があれば、その科目用の議事録/命名の書き方を
 * プロンプトに差し込んで生成する（無ければ共通既定）。
 * @return {Object} {subject, folder, confidence, reason, filename, title, minutesMarkdown}
 */
function analyzeWithGemini(transcript, capturedAt, tm, cfg) {
  var subjects = cfg.timetable.subjects;

  // 上書きを持つ科目が1つでもあるか。あれば「まず分類→上書きで議事録」の2段。
  // 無ければ従来どおり1回の呼び出しで分類＋議事録＋命名を取得する。
  var hasAnyOverride = false;
  for (var oi = 0; oi < subjects.length; oi++) {
    if ((subjects[oi].minutesOverride || '').trim() || (subjects[oi].namingOverride || '').trim()) {
      hasAnyOverride = true;
      break;
    }
  }

  if (!hasAnyOverride) {
    // ── 従来パス：1回で分類＋議事録＋命名 ──
    var parsed1 = geminiJson(buildAnalysisPrompt(transcript, capturedAt, tm, cfg, subjects, cfg.minutesGuide, cfg.namingRule));
    return finalizeAnalysis(parsed1, subjects);
  }

  // ── 上書きあり：①分類 → ②確定科目の上書きで議事録 ──
  // ① まず科目だけを当てる（議事録は短くてよい/後で本生成する）
  var classify = geminiJson(buildClassifyPrompt(transcript, capturedAt, tm, cfg, subjects));
  var subjectName = classify.subject || '未分類';
  var matched = matchSubject(subjects, subjectName);

  // ② 確定科目の上書き（無ければ共通既定）で議事録＋命名を本生成
  var minutesGuide = (matched && (matched.minutesOverride || '').trim()) ? matched.minutesOverride : cfg.minutesGuide;
  var namingRule = (matched && (matched.namingOverride || '').trim()) ? matched.namingOverride : cfg.namingRule;

  var fixedSubjects = matched ? [matched] : subjects;
  var parsed2 = geminiJson(buildAnalysisPrompt(transcript, capturedAt, tm, cfg, fixedSubjects, minutesGuide, namingRule, subjectName));

  // 分類結果（信頼度・理由）は①を優先し、議事録/命名/タイトルは②を採用
  var merged = {
    subject: subjectName,
    folder: parsed2.folder,
    confidence: classify.confidence != null ? classify.confidence : parsed2.confidence,
    reason: classify.reason || parsed2.reason,
    filename: parsed2.filename,
    title: parsed2.title,
    minutes_markdown: parsed2.minutes_markdown
  };
  return finalizeAnalysis(merged, subjects);
}

/** 科目名 → subjects 内の該当エントリ（完全一致優先、無ければ部分一致）。無ければ null。 */
function matchSubject(subjects, name) {
  if (!name) return null;
  for (var s = 0; s < subjects.length; s++) {
    if (subjects[s].name === name) return subjects[s];
  }
  for (var s2 = 0; s2 < subjects.length; s2++) {
    if (name.indexOf(subjects[s2].name) >= 0 || subjects[s2].name.indexOf(name) >= 0) return subjects[s2];
  }
  return null;
}

/** Gemini パース結果を最終 analysis オブジェクトに正規化（フォルダはローカル設定優先）。 */
function finalizeAnalysis(parsed, subjects) {
  var subjectName = parsed.subject || '未分類';
  var matched = matchSubject(subjects, subjectName);
  var folder = matched ? matched.folder : (parsed.folder || '_未分類');
  return {
    subject: subjectName,
    folder: folder,
    confidence: clamp01(Number(parsed.confidence != null ? parsed.confidence : 0.5)),
    reason: String(parsed.reason || ''),
    filename: sanitizeFilename(String(parsed.filename || parsed.title || subjectName)),
    title: String(parsed.title || parsed.filename || subjectName),
    minutesMarkdown: String(parsed.minutes_markdown || '')
  };
}

/** 科目選択肢のテキスト（"- 物理 → 保存先フォルダ「11」" の列挙）を作る。 */
function subjectsListText(subjects) {
  var lines = [];
  for (var i = 0; i < subjects.length; i++) {
    lines.push('- ' + subjects[i].name + ' → 保存先フォルダ「' + subjects[i].folder + '」');
  }
  return lines.join('\n');
}

/** 録音時刻ヒント文を作る。 */
function timeHintText(tm) {
  return tm
    ? '録音時刻から推定すると、時間割上は「' + tm.subject + '」のコマに当たります（' + tm.reason + '）。ただし補講や変更もあり得るので、内容と矛盾する場合は内容を優先してください。'
    : '録音時刻からの時間割推定は使えません。内容で判断してください。';
}

/**
 * 分類だけを行う軽量プロンプト（上書きあり時の①段で使用）。
 * @return {string}
 */
function buildClassifyPrompt(transcript, capturedAt, tm, cfg, subjects) {
  return (
'あなたは大学生の授業録音を整理するアシスタントです。\n' +
'以下の【文字起こし】が、どの授業科目かだけを判定してください（議事録は不要）。\n\n' +
'# 科目の選択肢（この中から1つ。必ず下記の科目名を使う）\n' +
subjectsListText(subjects) + '\n' +
'- どれにも当てはまらない場合のみ subject="未分類"\n\n' +
'# 分類のヒント（ユーザー記述）\n' +
(cfg.classifyHint || '（指定なし。内容から判断）') + '\n\n' +
'# 録音時刻の手掛かり\n' +
timeHintText(tm) + '\n\n' +
'# 出力フォーマット（厳守: JSONのみ。前後に文章を付けない）\n' +
'{\n' +
'  "subject": "科目名",\n' +
'  "confidence": 0.0〜1.0,\n' +
'  "reason": "なぜその科目と判断したか（1〜2文）"\n' +
'}\n\n' +
'# 文字起こし\n"""\n' +
String(transcript).slice(0, 200000) + '\n"""'
  );
}

/**
 * 分類＋議事録＋命名のフルプロンプト。
 * minutesGuide / namingRule は呼び出し側が（科目別上書き or 共通既定）を渡す。
 * fixedSubject が渡された場合は「この科目で確定」と明示する。
 * @return {string}
 */
function buildAnalysisPrompt(transcript, capturedAt, tm, cfg, subjects, minutesGuide, namingRule, fixedSubject) {
  var fixedNote = fixedSubject
    ? '※ この録音の科目は「' + fixedSubject + '」と確定しています。subject はこの科目名を使ってください。\n'
    : '';
  return (
'あなたは大学生の授業録音を整理するアシスタントです。\n' +
'以下の【文字起こし】が、どの授業科目かを判定し、復習用の議事録を作ってください。\n\n' +
'# 科目の選択肢（この中から1つ。必ず下記のいずれかの科目名・フォルダを使う）\n' +
subjectsListText(subjects) + '\n' +
'- どれにも当てはまらない場合のみ subject="未分類", folder="_未分類"\n' +
fixedNote + '\n' +
'# 分類のヒント（ユーザー記述）\n' +
(cfg.classifyHint || '（指定なし。内容から判断）') + '\n\n' +
'# 録音時刻の手掛かり\n' +
timeHintText(tm) + '\n\n' +
'# 議事録の書き方（ユーザー記述）\n' +
(minutesGuide || '授業の復習用に、今日の要点・重要用語・確認問題を含める。') + '\n' +
'- 目安の長さ: 約' + cfg.params.minutesTargetChars + '字\n' +
'- 言語: 日本語\n\n' +
'# ファイル名の付け方（ユーザー記述）\n' +
(namingRule || '日付_科目_内容 の順') + '\n' +
'- 録音日付: ' + dateStr(capturedAt) + '\n\n' +
'# 出力フォーマット（厳守: JSONのみ。前後に文章を付けない）\n' +
'{\n' +
'  "subject": "科目名",\n' +
'  "folder": "保存先フォルダ名",\n' +
'  "confidence": 0.0〜1.0,\n' +
'  "reason": "なぜその科目と判断したか（1〜2文）",\n' +
'  "filename": "拡張子なしのファイル名",\n' +
'  "title": "議事録のタイトル",\n' +
'  "minutes_markdown": "議事録本文(Markdown)"\n' +
'}\n\n' +
'# 文字起こし\n"""\n' +
String(transcript).slice(0, 200000) + '\n"""'
  );
}

function clamp01(x) {
  if (!isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * 議事録を Google ドキュメントで作成し、指定フォルダへ移動して URL を返す。
 * Markdown は簡易に Doc 段落へ変換（見出し # / 箇条書き - * / 番号付き 1.）。
 * @return {string} ドキュメントの URL
 */
function createMinutesDoc(analysis, destFolder) {
  var doc = DocumentApp.create(analysis.filename || analysis.title || '議事録');
  var bodyEl = doc.getBody();
  bodyEl.clear();

  // タイトル（H1相当）
  if (analysis.title) {
    var t = bodyEl.appendParagraph(analysis.title);
    t.setHeading(DocumentApp.ParagraphHeading.TITLE);
  }

  appendMarkdownToBody(bodyEl, analysis.minutesMarkdown);

  doc.saveAndClose();

  // 生成直後はマイドライブ直下にあるので、科目フォルダへ移動
  var docFile = DriveApp.getFileById(doc.getId());
  moveTo(docFile, destFolder);
  return doc.getUrl();
}

/**
 * Markdown 本文を簡易に Doc 段落へ流し込む。
 * 対応: # 見出し(1-6) / - * 箇条書き / 1. 番号付き / それ以外は通常段落。
 * 太字や表など複雑な記法は素通し（テキストとして残す）。
 */
function appendMarkdownToBody(bodyEl, markdown) {
  var lines = String(markdown || '').split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    var line = raw.replace(/\s+$/, '');
    if (line.trim() === '') {
      // 空行は段落の区切り。空段落を1つ入れて間を持たせる
      bodyEl.appendParagraph('');
      continue;
    }

    var h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      var level = h[1].length;
      var p = bodyEl.appendParagraph(stripInlineMarkdown(h[2]));
      p.setHeading(headingForLevel(level));
      continue;
    }

    var ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      bodyEl.appendListItem(stripInlineMarkdown(ul[1])).setGlyphType(DocumentApp.GlyphType.BULLET);
      continue;
    }

    var ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      bodyEl.appendListItem(stripInlineMarkdown(ol[1])).setGlyphType(DocumentApp.GlyphType.NUMBER);
      continue;
    }

    bodyEl.appendParagraph(stripInlineMarkdown(line));
  }
}

/** Markdownの強調記号(**, *, `)を素朴に剥がす（Doc段落はプレーンテキスト扱い）。 */
function stripInlineMarkdown(s) {
  return String(s)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^>\s?/, '');
}

/** 見出しレベル(1-6) → Doc の ParagraphHeading。 */
function headingForLevel(level) {
  switch (level) {
    case 1: return DocumentApp.ParagraphHeading.HEADING1;
    case 2: return DocumentApp.ParagraphHeading.HEADING2;
    case 3: return DocumentApp.ParagraphHeading.HEADING3;
    case 4: return DocumentApp.ParagraphHeading.HEADING4;
    case 5: return DocumentApp.ParagraphHeading.HEADING5;
    default: return DocumentApp.ParagraphHeading.HEADING6;
  }
}

// ── 冪等管理（処理済みファイルID） ───────────────
var PROCESSED_PROP_KEY = 'LOGRAKU_PROCESSED_IDS';
var PROCESSED_MAX = 500; // 記録上限（古い順に切り詰め）

function getProcessedIds() {
  var raw = PropertiesService.getScriptProperties().getProperty(PROCESSED_PROP_KEY);
  if (!raw) return [];
  try {
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function isAlreadyProcessed(fileId) {
  return getProcessedIds().indexOf(fileId) >= 0;
}

function markProcessed(fileId) {
  var ids = getProcessedIds();
  if (ids.indexOf(fileId) >= 0) return;
  ids.push(fileId);
  if (ids.length > PROCESSED_MAX) ids = ids.slice(ids.length - PROCESSED_MAX);
  PropertiesService.getScriptProperties().setProperty(PROCESSED_PROP_KEY, JSON.stringify(ids));
}

// ── 通知（Discord Webhook / Logger フォールバック） ──
function notifyResult(r) {
  var heldForReview = !!r.heldForReview;
  var confidencePct = Math.round(r.confidence * 100);
  var plainSummary = (heldForReview ? '🟡 要確認' : '✅') + ' 授業ファイルを作成しました: ' + r.subject;

  var embed = {
    title: (heldForReview ? '🟡 要確認：授業ファイルを作成しました' : '✅ 授業ファイルを作成しました'),
    url: r.docUrl,
    color: heldForReview ? 15844367 : 3066993, // 黄色 / 緑
    fields: [
      { name: '科目', value: r.subject + '（信頼度' + confidencePct + '%）', inline: false },
      { name: '保存先', value: r.destFolderName + '/' + r.filename, inline: false }
    ],
    timestamp: new Date().toISOString()
  };

  var webhook = PropertiesService.getUserProperties().getProperty('DISCORD_WEBHOOK_URL')
    || PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK_URL');
  if (!webhook) {
    Logger.log('[ログらく通知] ' + plainSummary + ' / ' + r.docUrl);
    return;
  }
  try {
    var res = UrlFetchApp.fetch(webhook, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ embeds: [embed] }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      Logger.log('ログらく: Discord Webhookがエラーを返しました（HTTP ' + code + '）: ' + res.getContentText());
    }
  } catch (e) {
    Logger.log('ログらく: Discord 通知に失敗（Logger にフォールバック）: ' + plainSummary + ' / エラー: ' + (e && e.message ? e.message : e));
  }
}

// ── トリガー管理 ────────────────────────────────
var TRIGGER_HANDLER = 'classifyInbox';

/** classifyInbox を30分毎の時間トリガーに登録（重複しない）。 */
function installTrigger() {
  removeTriggers();
  ScriptApp.newTrigger(TRIGGER_HANDLER)
    .timeBased()
    .everyMinutes(30)
    .create();
  Logger.log('ログらく: 30分毎トリガーを登録しました。');
}

/** classifyInbox の時間トリガーを全削除。 */
function removeTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('ログらく: トリガーを ' + removed + ' 件削除しました。');
}

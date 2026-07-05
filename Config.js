/**
 * Config.gs — lograku.md（正本）を読んで設定オブジェクトに構造化する。
 * Node版 src/config.ts / src/util.ts(時刻まわり) を GAS(プレーンJS) に移植。
 * 機械が確実に使うのは「時間割」「科目→保存先フォルダ」「詳細設定」だけ。
 * 「分類のヒント」「議事録の書き方」等は原文のまま AI に渡す。
 */

// 設計値の既定。lograku.md「# 詳細設定」で上書きされる。
var DEFAULT_PARAMS = {
  minConfidence: 0.6,
  maxCharsPerChunk: 10000,
  minutesTargetChars: 1000,
  language: 'ja',
  useTimeMatch: true,
  timeMatchWeight: 0.5,
  minTranscriptChars: 300,
  reviewFolder: '_要確認'
};

// 標準的な大学90分授業の時限→時刻（時間割に時刻が無いとき使う既定値）
var DEFAULT_PERIOD_TIMES = {
  1: { start: '09:00', end: '10:30' },
  2: { start: '10:40', end: '12:10' },
  3: { start: '13:00', end: '14:30' },
  4: { start: '14:40', end: '16:10' },
  5: { start: '16:20', end: '17:50' }
};

var WEEKDAYS_SET = { '月': 1, '火': 1, '水': 1, '木': 1, '金': 1, '土': 1, '日': 1 };

/**
 * 基底フォルダ直下の lograku.md を読んで構造化する。
 * @param {Folder} base 基底フォルダ
 * @return {Object} {timetable:{subjects,schedule}, classifyHint, namingRule, minutesGuide, outputs, params}
 *   subjects: [{name, folder, keywords:[]}]
 *   schedule: [{day, period, start, end, subject}]
 */
function loadConfig(base) {
  var text = readConfigDoc(base);
  if (text == null) {
    throw new Error('基底フォルダ「' + BASE_FOLDER_NAME + '」直下に ' + CONFIG_FILE_NAME + ' がありません。設定Webアプリで作成してください。');
  }
  return parseConfig(text);
}

/** lograku.md 本文(markdown)を構造化する。 */
function parseConfig(md) {
  var sections = splitSections(md);

  var subjects = parseSubjects(findSection(sections, ['保存先', '科目', 'フォルダ']) || '');
  var classifyHint = findSection(sections, ['分類', 'ヒント']) || '';
  var namingRule = findSection(sections, ['ファイル名', '命名', '名前']) || '';
  var minutesGuide = findSection(sections, ['議事録', '要約', 'まとめ方']) || '';
  var outputs = findSection(sections, ['出力', '通知', '保存先・通知']) || '';
  var params = parseParams(findSection(sections, ['詳細設定', '設定値', 'パラメータ']) || '');

  applyHintKeywords(subjects, classifyHint);

  // 科目別の上書き（任意）: subjects[].minutesOverride / namingOverride に格納
  applySubjectOverrides(subjects, findSubjectOverrideBody(sections));

  var schedule = parseSchedule(findSection(sections, ['時間割', 'スケジュール']) || '', subjects);

  return {
    timetable: { subjects: subjects, schedule: schedule },
    classifyHint: classifyHint,
    namingRule: namingRule,
    minutesGuide: minutesGuide,
    outputs: outputs,
    params: params
  };
}

// ── セクション分割 ──────────────────────────────
function splitSections(md) {
  var lines = md.split(/\r?\n/);
  var out = [];
  var cur = null;
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^#{1,6}\s+(.*)$/);
    if (m) {
      if (cur) out.push(cur);
      cur = { heading: m[1].trim(), body: '' };
    } else if (cur) {
      cur.body += lines[i] + '\n';
    }
  }
  if (cur) out.push(cur);
  return out;
}

function findSection(sections, keywords) {
  for (var i = 0; i < sections.length; i++) {
    var s = sections[i];
    for (var k = 0; k < keywords.length; k++) {
      if (s.heading.indexOf(keywords[k]) >= 0) return s.body.replace(/\s+$/, '').replace(/^\s+/, '');
    }
  }
  return null;
}

// ── 科目→保存先フォルダ ─────────────────────────
function parseSubjects(body) {
  var subjects = [];
  var lines = body.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/^\s*<!--/.test(line)) continue; // HTMLコメント行は無視
    // 「- 物理: 11」「* 数学：12」。値側の「# 11=月1限」等の行内コメントは落とす。
    var m = line.match(/^\s*[-*]\s*(.+?)\s*[:：]\s*(.+?)\s*$/);
    if (m) {
      var name = m[1].trim();
      var folder = m[2].replace(/\s*#.*$/, '').trim(); // 行内 # コメントを除去
      if (name && folder) subjects.push({ name: name, folder: folder, keywords: [] });
    }
  }
  return subjects;
}

// ── 分類のヒント → 科目別キーワード ──────────────
function applyHintKeywords(subjects, hint) {
  var lines = hint.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    var subj = null;
    for (var s = 0; s < subjects.length; s++) {
      if (ln.indexOf(subjects[s].name) >= 0) { subj = subjects[s]; break; }
    }
    if (!subj) continue;
    // 「」内、または ：の後ろを ・,、，/ 空白 で分割
    var quoted = ln.match(/[「『]([^」』]+)[」』]/);
    var raw;
    if (quoted) {
      raw = quoted[1];
    } else {
      var afterColon = ln.split(/[:：]/);
      raw = afterColon.length > 1 ? afterColon[1] : '';
    }
    var kws = raw.split(/[・,、，\/\s]+/);
    for (var j = 0; j < kws.length; j++) {
      var k = kws[j].trim();
      if (k.length >= 1 && k !== subj.name && subj.keywords.indexOf(k) < 0) {
        subj.keywords.push(k);
      }
    }
  }
}

// ── 科目別の上書き（任意） ──────────────────────
/**
 * 「# 科目別の上書き（任意）」配下の生テキストを切り出す。
 * splitSections は ## も独立セクションにするため、ここでは元の見出し配列から
 * その # 見出し位置〜次の # 見出し直前までを走査して原文ブロックを復元する。
 * @return {string} 上書きセクション本文（## 科目 以下を含む）。無ければ ''。
 */
function findSubjectOverrideBody(sections) {
  var startIdx = -1;
  for (var i = 0; i < sections.length; i++) {
    var h = sections[i].heading || '';
    // level は heading 文字列からは判定できないので、見出し名で判定（「科目別」「上書き」）
    if (h.indexOf('科目別') >= 0 || h.indexOf('上書き') >= 0) { startIdx = i; break; }
  }
  if (startIdx < 0) return '';

  // startIdx の本文（コメント等）＋以降の ## サブ見出しを、次の level-1 見出しまで連結。
  // 「level-1 の終わり」は heading 名がトップレベルの既知セクション名に当たるところで判定する。
  var topLevelMarks = ['出力', '通知', '詳細設定', '設定値', 'パラメータ', '時間割', 'スケジュール',
    '保存先', '分類', 'ファイル名', '命名', '議事録', '要約'];
  var out = [];
  // 開始見出し自身のコメント本文も残す（無害）
  out.push(sections[startIdx].body || '');
  for (var j = startIdx + 1; j < sections.length; j++) {
    var hd = sections[j].heading || '';
    var isTop = false;
    for (var t = 0; t < topLevelMarks.length; t++) {
      if (hd.indexOf(topLevelMarks[t]) >= 0) { isTop = true; break; }
    }
    if (isTop) break; // 次の主要セクションに到達 → 上書きブロック終了
    out.push('## ' + hd);
    out.push(sections[j].body || '');
  }
  return out.join('\n');
}

/**
 * 上書きブロックをパースして subjects[].minutesOverride / namingOverride に格納する。
 * 形式:
 *   ## 物理
 *   - 議事録: ...
 *   - 命名: ...
 * 空欄の項目は無視（共通既定が使われる）。
 */
function applySubjectOverrides(subjects, body) {
  for (var s = 0; s < subjects.length; s++) {
    if (subjects[s].minutesOverride === undefined) subjects[s].minutesOverride = '';
    if (subjects[s].namingOverride === undefined) subjects[s].namingOverride = '';
  }
  if (!body) return;

  var lines = body.split(/\r?\n/);
  var cur = null; // 現在の科目ブロック対象
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    var hm = ln.match(/^\s*##\s+(.+?)\s*$/);
    if (hm) {
      var name = hm[1].trim();
      cur = null;
      for (var k = 0; k < subjects.length; k++) {
        if (subjects[k].name === name) { cur = subjects[k]; break; }
      }
      // 完全一致が無ければ部分一致でも拾う（命名ゆらぎ対策）
      if (!cur) {
        for (var k2 = 0; k2 < subjects.length; k2++) {
          if (name.indexOf(subjects[k2].name) >= 0 || subjects[k2].name.indexOf(name) >= 0) {
            cur = subjects[k2]; break;
          }
        }
      }
      continue;
    }
    if (!cur) continue;

    var mm = ln.match(/^\s*[-*]\s*議事録\s*[:：]\s*(.*)$/);
    if (mm) {
      var v1 = mm[1].trim();
      if (v1) cur.minutesOverride = v1;
      continue;
    }
    var nm = ln.match(/^\s*[-*]\s*命名\s*[:：]\s*(.*)$/);
    if (nm) {
      var v2 = nm[1].trim();
      if (v2) cur.namingOverride = v2;
      continue;
    }
  }
}

// ── 時間割テーブル ──────────────────────────────
function parseSchedule(body, subjects) {
  var rawLines = body.split(/\r?\n/);
  var rows = [];
  for (var i = 0; i < rawLines.length; i++) {
    var l = rawLines[i].trim();
    if (l.indexOf('|') !== 0) continue;
    var cells = l.replace(/^\||\|$/g, '').split('|');
    for (var c = 0; c < cells.length; c++) cells[c] = cells[c].trim();
    rows.push(cells);
  }
  if (rows.length === 0) return [];

  // ヘッダ行から列位置を特定
  var header = rows[0];
  function col(keys) {
    for (var h = 0; h < header.length; h++) {
      for (var k = 0; k < keys.length; k++) {
        if (header[h].indexOf(keys[k]) >= 0) return h;
      }
    }
    return -1;
  }
  var iDay = col(['曜日', '曜']);
  var iPeriod = col(['時限', '限', 'コマ']);
  var iTime = col(['時刻', '時間']);
  var iStart = col(['開始', '始']);
  var iEnd = col(['終了', '終']);
  var iSubject = col(['科目', '授業']);
  if (iDay < 0 || iSubject < 0) return [];

  var entries = [];
  for (var r = 1; r < rows.length; r++) {
    var row = rows[r];
    // 区切り行（---|--- 等）はスキップ
    var allSep = true;
    for (var ci = 0; ci < row.length; ci++) {
      if (!/^[-:\s]*$/.test(row[ci])) { allSep = false; break; }
    }
    if (allSep) continue;

    var day = (row[iDay] || '').trim();
    if (!WEEKDAYS_SET[day]) continue;
    var subjectRaw = (row[iSubject] || '').trim();
    if (!subjectRaw) continue;

    var subjectName = subjectRaw;
    for (var sj = 0; sj < subjects.length; sj++) {
      if (subjectRaw.indexOf(subjects[sj].name) >= 0) { subjectName = subjects[sj].name; break; }
    }

    var period = parseInt((row[iPeriod] || '').replace(/[^0-9]/g, ''), 10) || 0;
    var def = DEFAULT_PERIOD_TIMES[period] || { start: '00:00', end: '23:59' };

    var start = def.start;
    var end = def.end;
    var rangeCell = iTime >= 0 ? (row[iTime] || '') : '';
    var range = rangeCell ? parseTimeRange(rangeCell) : null;
    if (range) {
      start = range.start;
      end = range.end;
    } else {
      if (iStart >= 0 && row[iStart]) start = normalizeTime(row[iStart]);
      if (iEnd >= 0 && row[iEnd]) end = normalizeTime(row[iEnd]);
    }
    entries.push({ day: day, period: period, start: start, end: end, subject: subjectName });
  }
  return entries;
}

function normalizeTime(s) {
  var m = s.match(/(\d{1,2})\s*[:：時]\s*(\d{1,2})?/);
  if (!m) return s.trim();
  var h = padZero(m[1]);
  var mm = padZero(m[2] || '00');
  return h + ':' + mm;
}

/** "9:00-10:30" / "9時〜10時半" 等の時刻レンジを {start,end} に正規化（不能なら null） */
function parseTimeRange(s) {
  var parts = s.split(/[-–—~〜～]/);
  if (parts.length < 2) return null;
  var start = normTime(parts[0]);
  var end = normTime(parts[1]);
  if (!start || !end) return null;
  return { start: start, end: end };
}

function normTime(s) {
  var m = s.match(/(\d{1,2})\s*[:：時]\s*(\d{1,2})?/);
  if (!m) return null;
  var h = padZero(m[1]);
  var mm = padZero(m[2] || '00');
  return h + ':' + mm;
}

function padZero(s) {
  s = String(s);
  return s.length >= 2 ? s : ('00' + s).slice(-2);
}

// ── 詳細設定（任意） ────────────────────────────
function parseParams(body) {
  var p = {};
  for (var key in DEFAULT_PARAMS) {
    if (DEFAULT_PARAMS.hasOwnProperty(key)) p[key] = DEFAULT_PARAMS[key];
  }
  var lines = body.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^\s*[-*]?\s*([A-Za-z]+)\s*[:：]\s*(.+?)\s*$/);
    if (!m) continue;
    var k = m[1];
    var val = m[2].trim();
    switch (k) {
      case 'minConfidence': p.minConfidence = num(val, p.minConfidence); break;
      case 'timeMatchWeight': p.timeMatchWeight = num(val, p.timeMatchWeight); break;
      case 'minutesTargetChars': p.minutesTargetChars = num(val, p.minutesTargetChars); break;
      case 'maxCharsPerChunk': p.maxCharsPerChunk = num(val, p.maxCharsPerChunk); break;
      case 'minTranscriptChars': p.minTranscriptChars = num(val, p.minTranscriptChars); break;
      case 'language': p.language = val; break;
      case 'reviewFolder': p.reviewFolder = val; break;
      case 'useTimeMatch': p.useTimeMatch = /^(true|yes|on|1|有効)$/i.test(val); break;
    }
  }
  return p;
}

function num(v, fallback) {
  var n = parseFloat(v);
  return isFinite(n) ? n : fallback;
}

// ── 時刻 × 時間割 照合（util.ts の matchSchedule 移植） ──
/**
 * 録音時刻(Date)が時間割のどのコマに当たるか判定。
 * 同曜日のコマで時刻が[start,end]内なら weight=1、前後30分以内は線形減衰、それ以上は候補外。
 * @param {Date} capturedAt 録音時刻
 * @param {Array} schedule [{day,period,start,end,subject}]
 * @return {Object|null} {subject, weight, reason}
 */
function matchSchedule(capturedAt, schedule) {
  if (!capturedAt || isNaN(capturedAt.getTime())) return null;
  var wdNames = ['日', '月', '火', '水', '木', '金', '土'];
  var wd = wdNames[capturedAt.getDay()];
  var tod = capturedAt.getHours() * 60 + capturedAt.getMinutes();

  var best = null;
  for (var i = 0; i < schedule.length; i++) {
    var e = schedule[i];
    if (e.day !== wd) continue;
    var start = hhmmToMin(e.start);
    var end = hhmmToMin(e.end);
    var weight = 0;
    var reason = '';
    if (tod >= start && tod <= end) {
      weight = 1;
      reason = '録音時刻 ' + fmtMin(tod) + ' は ' + wd + e.period + '限(' + e.start + '-' + e.end + ')に一致';
    } else {
      var gap = tod < start ? start - tod : tod - end;
      if (gap <= 30) {
        weight = 1 - gap / 30;
        reason = '録音時刻 ' + fmtMin(tod) + ' は ' + wd + e.period + '限(' + e.start + '-' + e.end + ')の' + gap + '分' + (tod < start ? '前' : '後');
      }
    }
    if (weight > 0 && (!best || weight > best.weight)) {
      best = { subject: e.subject, weight: weight, reason: reason };
    }
  }
  return best;
}

function hhmmToMin(hhmm) {
  var parts = String(hhmm).split(':');
  var h = parseInt(parts[0], 10) || 0;
  var m = parseInt(parts[1], 10) || 0;
  return h * 60 + m;
}

function fmtMin(min) {
  var h = Math.floor(min / 60);
  var m = min % 60;
  return padZero(h) + ':' + padZero(m);
}

// ── テキスト処理ユーティリティ ──────────────────
/** text 中の keyword の出現回数（NFKC正規化後の単純部分一致） */
function countOccurrences(text, keyword) {
  var t = String(text).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
  var k = String(keyword).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
  if (!k) return 0;
  var count = 0;
  var i = 0;
  while ((i = t.indexOf(k, i)) !== -1) {
    count++;
    i += k.length;
  }
  return count;
}

/** ファイル名として使えない文字を潰す（拡張子なし前提） */
function sanitizeFilename(name) {
  return String(name)
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
}

/** Date → "YYYY-MM-DD"（Asia/Tokyo） */
function dateStr(d) {
  var dd = (d && !isNaN(d.getTime())) ? d : new Date();
  return Utilities.formatDate(dd, 'Asia/Tokyo', 'yyyy-MM-dd');
}

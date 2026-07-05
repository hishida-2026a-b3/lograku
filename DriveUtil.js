/**
 * DriveUtil.gs — Drive 操作の共通ヘルパ（GAS / DriveApp 版）。
 * Node版 storage.local.ts / storage.gdrive.ts の Drive 相当ロジックをここに集約する。
 * 基底フォルダ「ログらく」を本拠地とし、その直下に _inbox / _done / lograku.md を置く。
 */

// 基底フォルダ名（この名前のフォルダを「ログらく」の本拠地にする）
var BASE_FOLDER_NAME = 'ログらく';
var INBOX_FOLDER_NAME = '_inbox';
var DONE_FOLDER_NAME = '_done';
var CONFIG_FILE_NAME = 'lograku.md';

// 入力として扱う拡張子
var AUDIO_EXT = ['mp3', 'm4a', 'mp4', 'wav', 'aac', 'ogg', 'webm', 'flac'];
var TEXT_EXT = ['txt', 'md', 'vtt', 'srt'];

/**
 * 親フォルダ直下に name のフォルダがあれば返し、無ければ作る。
 * @param {Folder} parent 親フォルダ
 * @param {string} name フォルダ名
 * @return {Folder}
 */
function findOrCreateFolder(parent, name) {
  var it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

/**
 * マイドライブ直下から基底フォルダ「ログらく」を探す。無ければ作る。
 * @param {boolean=} createIfMissing 既定 true。false の場合、無ければ null。
 * @return {Folder|null}
 */
function getBaseFolder(createIfMissing) {
  if (createIfMissing === undefined) createIfMissing = true;
  var root = DriveApp.getRootFolder();
  var it = root.getFoldersByName(BASE_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  if (!createIfMissing) return null;
  return root.createFolder(BASE_FOLDER_NAME);
}

/** 基底直下の _inbox フォルダ（無ければ作る）。 */
function getInboxFolder(base) {
  return findOrCreateFolder(base, INBOX_FOLDER_NAME);
}

/** 基底直下の _done フォルダ（無ければ作る）。 */
function getDoneFolder(base) {
  return findOrCreateFolder(base, DONE_FOLDER_NAME);
}

/**
 * 基底フォルダ直下の lograku.md の本文を読む。無ければ null。
 * @param {Folder} base 基底フォルダ
 * @return {string|null}
 */
function readConfigDoc(base) {
  var it = base.getFilesByName(CONFIG_FILE_NAME);
  if (!it.hasNext()) return null;
  return it.next().getBlob().getDataAsString('UTF-8');
}

/**
 * 基底フォルダ直下に lograku.md を書く（既存なら上書き）。
 * @param {Folder} base 基底フォルダ
 * @param {string} text 本文
 * @return {File}
 */
function writeConfigDoc(base, text) {
  var it = base.getFilesByName(CONFIG_FILE_NAME);
  if (it.hasNext()) {
    var f = it.next();
    f.setContent(text);
    return f;
  }
  return base.createFile(CONFIG_FILE_NAME, text, 'text/markdown');
}

/**
 * 音声に対応する文字起こしサイドカー（<base>.ja.txt）を _inbox 直下から探す。無ければ null。
 * @param {Folder} base 基底フォルダ
 * @param {string} audioBaseName 音声のベース名（baseOf の戻り）
 * @return {File|null}
 */
function findTranscriptSidecar(base, audioBaseName) {
  var inbox = getInboxFolder(base);
  var sidecarName = audioBaseName + '.ja.txt';
  var it = inbox.getFilesByName(sidecarName);
  if (it.hasNext()) return it.next();
  return null;
}

/**
 * 文字起こしサイドカー（<base>.ja.txt）を _inbox 直下に書く（既存なら上書き）。
 * 振り分けが落ちても次回は文字起こしをスキップして再開できるようにするための中間ファイル。
 * @param {Folder} base 基底フォルダ
 * @param {string} audioBaseName 音声のベース名（baseOf の戻り）
 * @param {string} text 文字起こし本文
 * @return {File}
 */
function writeTranscriptSidecar(base, audioBaseName, text) {
  var inbox = getInboxFolder(base);
  var sidecarName = audioBaseName + '.ja.txt';
  var it = inbox.getFilesByName(sidecarName);
  if (it.hasNext()) {
    var f = it.next();
    f.setContent(text);
    return f;
  }
  return inbox.createFile(sidecarName, text, 'text/plain');
}

/** 拡張子（小文字・ドット無し）を返す。 */
function extOf(name) {
  var i = name.lastIndexOf('.');
  if (i < 0) return '';
  return name.slice(i + 1).toLowerCase();
}

/** 拡張子を除いたベース名（storage.local.ts の baseOf 相当。.ja も剥がす）。 */
function baseOf(name) {
  var i = name.lastIndexOf('.');
  var b = i < 0 ? name : name.slice(0, i);
  return b.replace(/\.ja$/, '');
}

/**
 * _inbox 内の入力ファイル（音声/テキスト）を列挙する。
 * .meta.json やサイドカー字幕(<base>.ja.txt 等。同名音声があるもの)は入力に数えない。
 * @param {Folder} base 基底フォルダ
 * @return {Array<{file: File, name: string, kind: string}>}
 */
function listInboxFiles(base) {
  var inbox = getInboxFolder(base);
  var all = [];
  var fit = inbox.getFiles();
  while (fit.hasNext()) {
    all.push(fit.next());
  }
  // 音声のベース名集合（サイドカー判定用）
  var audioBases = {};
  for (var i = 0; i < all.length; i++) {
    if (AUDIO_EXT.indexOf(extOf(all[i].getName())) >= 0) {
      audioBases[baseOf(all[i].getName())] = true;
    }
  }
  // 名前順に安定化
  all.sort(function (a, b) {
    return a.getName() < b.getName() ? -1 : a.getName() > b.getName() ? 1 : 0;
  });

  var out = [];
  for (var j = 0; j < all.length; j++) {
    var file = all[j];
    var name = file.getName();
    var ext = extOf(name);
    if (AUDIO_EXT.indexOf(ext) >= 0) {
      out.push({ file: file, name: name, kind: 'audio' });
    } else if (TEXT_EXT.indexOf(ext) >= 0) {
      // 同名音声があるテキストはサイドカー字幕とみなし入力にしない
      var base2 = baseOf(name);
      var isSidecar =
        audioBases[base2] &&
        (/\.ja\.txt$/.test(name) || ext === 'txt' || ext === 'vtt' || ext === 'srt');
      if (!isSidecar) out.push({ file: file, name: name, kind: 'text' });
    }
    // .meta.json 等は無視
  }
  return out;
}

/**
 * テキスト系ファイルの本文を読み込む（UTF-8）。
 * @param {File} file
 * @return {string}
 */
function fileText(file) {
  return file.getBlob().getDataAsString('UTF-8');
}

/**
 * 録音時刻を推定する。ファイル名の日時パターン優先、無ければ getDateCreated()。
 * @param {File} file
 * @return {Date}
 */
function capturedAtOf(file) {
  var name = file.getName();
  // YYYY-MM-DD HHMM / YYYYMMDD_HHMM などを許容
  var m = name.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})[ _T]?(\d{2})[:_-]?(\d{2})/);
  if (m) {
    var d = new Date(
      parseInt(m[1], 10),
      parseInt(m[2], 10) - 1,
      parseInt(m[3], 10),
      parseInt(m[4], 10),
      parseInt(m[5], 10),
      0
    );
    if (!isNaN(d.getTime())) return d;
  }
  // 日付だけ（時刻なし）
  var md = name.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
  if (md) {
    var d2 = new Date(parseInt(md[1], 10), parseInt(md[2], 10) - 1, parseInt(md[3], 10), 0, 0, 0);
    if (!isNaN(d2.getTime())) return d2;
  }
  return file.getDateCreated();
}

/**
 * ファイルを基底フォルダ配下の指定フォルダへ移動する（旧親から外す）。
 * @param {File} file
 * @param {Folder} destFolder
 */
function moveTo(file, destFolder) {
  destFolder.addFile(file);
  // 旧親（_inbox 等）から外す
  var parents = file.getParents();
  while (parents.hasNext()) {
    var p = parents.next();
    if (p.getId() !== destFolder.getId()) p.removeFile(file);
  }
}

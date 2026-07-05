/**
 * Gemini.gs — Gemini REST クライアント（GAS / UrlFetchApp 版）。
 * Node版 gemini-client.ts を移植。文字起こし(inline_data)と分類+議事録(JSON)で共用。
 * APIキーは User Property GEMINI_API_KEY 優先、無ければ Script Property GEMINI_API_KEY から読む（コード直書き禁止）。
 * model 既定 gemini-2.5-flash、Script Property GEMINI_MODEL で上書き可。
 */

var GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
var GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';

/** API キーを取得。UserProperties 優先 → 無ければ ScriptProperties。両方未設定なら例外。 */
function geminiApiKey() {
  var key = PropertiesService.getUserProperties().getProperty('GEMINI_API_KEY')
         || PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) {
    throw new Error('Gemini APIキーが未設定です。各自は設定フォームでGeminiキーを入力、またはオーナーがスクリプトプロパティに GEMINI_API_KEY を設定してください。');
  }
  return key;
}

/** 使用モデル名（GEMINI_MODEL で上書き可）。 */
function geminiModel() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || GEMINI_DEFAULT_MODEL;
}

/**
 * generateContent を叩いて本文テキストを返す（低レベルAPI）。
 * @param {Array} parts [{text:..}] / [{inline_data:{mime_type,data}}] の配列
 * @param {Object=} opts {json:boolean, temperature:number, model:string}
 * @return {string} 生成テキスト
 */
function geminiGenerate(parts, opts) {
  opts = opts || {};
  var key = geminiApiKey();
  var model = opts.model || geminiModel();
  var body = {
    contents: [{ parts: parts }],
    generationConfig: {
      temperature: (opts.temperature != null) ? opts.temperature : 0.3
    }
  };
  if (opts.json) body.generationConfig.responseMimeType = 'application/json';

  var url = GEMINI_ENDPOINT + '/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);
  var params = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  };

  // 429/503 は最大3回までリトライ（指数バックオフ）
  var maxAttempts = 3;
  var lastErr = '';
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    var res = UrlFetchApp.fetch(url, params);
    var code = res.getResponseCode();
    var text = res.getContentText();
    if (code >= 200 && code < 300) {
      var data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('Gemini 応答のJSON解釈に失敗: ' + text.slice(0, 300));
      }
      var out = '';
      if (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
        var ps = data.candidates[0].content.parts;
        for (var i = 0; i < ps.length; i++) {
          if (ps[i].text) out += ps[i].text;
        }
      }
      if (!out) throw new Error('Gemini から空応答（safety ブロック等の可能性）: ' + text.slice(0, 300));
      return out;
    }
    if (code === 429 || code === 503) {
      lastErr = 'Gemini API ' + code + ': ' + text.slice(0, 300);
      if (attempt < maxAttempts) {
        Utilities.sleep(1000 * attempt); // 1s, 2s
        continue;
      }
    }
    throw new Error('Gemini API エラー ' + code + ': ' + text.slice(0, 500));
  }
  throw new Error('Gemini API リトライ上限に到達: ' + lastErr);
}

/** プロンプト文字列を渡してテキスト応答を得る薄いラッパ。 */
function geminiText(prompt) {
  return geminiGenerate([{ text: prompt }], { json: false });
}

/** プロンプト文字列を渡し、JSONを解釈して返す薄いラッパ。 */
function geminiJson(prompt) {
  var raw = geminiGenerate([{ text: prompt }], { json: true, temperature: 0.3 });
  return parseGeminiJson(raw);
}

/** Gemini応答からJSONを取り出す（コードフェンス除去・フォールバック付き）。 */
function parseGeminiJson(raw) {
  var s = String(raw).trim();
  if (s.indexOf('```') === 0) {
    s = s.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  }
  try {
    return JSON.parse(s);
  } catch (e) {
    var m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (e2) { /* fallthrough */ }
    }
    throw new Error('Gemini 応答をJSON解釈できません: ' + String(raw).slice(0, 300));
  }
}

/**
 * 音声等の Blob を Gemini Files API へアップロードし、ACTIVE になるまで待って参照を返す。
 * 20MB超の長尺音声を inline_data ではなく file_data で渡すための入口。
 * レジューマブルアップロード（start で URL 取得 → finalize で本体送信）→ ポーリングで ACTIVE 待ち。
 * @param {Blob} blob アップロードする音声（payload に直接渡してストリーム送信する）
 * @param {string} mimeType MIME（例 'audio/mp3'）
 * @param {string=} displayName 表示名（省略時 'audio'）
 * @param {number} numBytes バイト数。呼び出し側が file.getSize() を渡す（getBytes() で全バイトを
 *   JS配列に展開するとメモリ不足で落ちるため、サイズはメタ情報から取り、本体は Blob のまま送る）。
 * @return {{uri:string, name:string, mimeType:string}} generateContent の file_data に渡せる参照
 */
function geminiUploadFile(blob, mimeType, displayName, numBytes) {
  var key = geminiApiKey();

  // ① start: アップロード先 URL を採番する
  var startUrl = 'https://generativelanguage.googleapis.com/upload/v1beta/files?key=' + encodeURIComponent(key);
  var startRes = UrlFetchApp.fetch(startUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(numBytes),
      'X-Goog-Upload-Header-Content-Type': mimeType
    },
    payload: JSON.stringify({ file: { display_name: displayName || 'audio' } }),
    muteHttpExceptions: true
  });
  var startCode = startRes.getResponseCode();
  if (startCode < 200 || startCode >= 300) {
    throw new Error('Files API start エラー ' + startCode + ': ' + startRes.getContentText().slice(0, 500));
  }
  var uploadUrl = headerValueCI(startRes.getHeaders(), 'x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Files API start 応答に x-goog-upload-url がありません。');
  }

  // ② finalize: 本体を送り切ってファイルを確定する（Blob を直接渡し＝メモリに全載せしない。応答は { file: {...} } ラップ）
  var finRes = UrlFetchApp.fetch(uploadUrl, {
    method: 'post',
    contentType: mimeType,
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0'
    },
    payload: blob,
    muteHttpExceptions: true
  });
  var finCode = finRes.getResponseCode();
  if (finCode < 200 || finCode >= 300) {
    throw new Error('Files API finalize エラー ' + finCode + ': ' + finRes.getContentText().slice(0, 500));
  }
  var finText = finRes.getContentText();
  var data;
  try {
    data = JSON.parse(finText);
  } catch (e) {
    throw new Error('Files API finalize 応答のJSON解釈に失敗: ' + finText.slice(0, 300));
  }
  var file = data.file;
  if (!file || !file.name) {
    throw new Error('Files API finalize 応答に file.name がありません: ' + finText.slice(0, 300));
  }

  // ③ ACTIVE になるまで待つ
  return waitForFileActive(file.name, key);
}

/**
 * アップロード済みファイルが ACTIVE になるまでポーリングする（上限 約4分・指数バックオフ）。
 * @param {string} name 'files/xxxx' 形式のリソース名（接頭辞込み・自分で files/ を付けない）
 * @param {string} key API キー
 * @return {{uri:string, name:string, mimeType:string}}
 */
function waitForFileActive(name, key) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/' + name + '?key=' + encodeURIComponent(key);
  var waitMs = 2000;
  var elapsed = 0;
  var maxElapsed = 4 * 60 * 1000;
  while (true) {
    var res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true });
    var code = res.getResponseCode();
    var text = res.getContentText();
    if (code < 200 || code >= 300) {
      throw new Error('Files API get エラー ' + code + ': ' + text.slice(0, 500));
    }
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('Files API get 応答のJSON解釈に失敗: ' + text.slice(0, 300));
    }
    if (data.state === 'ACTIVE') {
      return { uri: data.uri, name: data.name, mimeType: data.mimeType };
    }
    if (data.state === 'FAILED') {
      throw new Error('Files API: ファイル処理に失敗しました（state=FAILED, ' + name + '）。');
    }
    // PROCESSING 等 → 待ってリトライ
    if (elapsed >= maxElapsed) {
      throw new Error('Files API: ACTIVE 待ちが約4分を超えました（state=' + data.state + ', ' + name + '）。');
    }
    Utilities.sleep(waitMs);
    elapsed += waitMs;
    waitMs = Math.min(Math.floor(waitMs * 1.5), 15000);
  }
}

/**
 * ヘッダ群（res.getHeaders() の戻り）から、キーを大小文字無視で探して値を返す。
 * GAS は多値ヘッダを配列で返すことがあるため、配列なら先頭要素を採る。
 * @param {Object} headers res.getHeaders() の戻り
 * @param {string} lowerKey 小文字化済みの探索キー（例 'x-goog-upload-url'）
 * @return {string} 値（見つからなければ ''）
 */
function headerValueCI(headers, lowerKey) {
  for (var k in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, k) && k.toLowerCase() === lowerKey) {
      var v = headers[k];
      return Array.isArray(v) ? (v[0] || '') : String(v);
    }
  }
  return '';
}

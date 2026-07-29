<div align="center">

# mistai

**P2P ルームで LLM を共有するライブラリ — 1つのブラウザがモデルを貸し、ほかのブラウザが使う。**

[![version](https://img.shields.io/github/v/tag/tik-choco-lab/mistai?label=version&color=2f6feb)](https://github.com/tik-choco-lab/mistai/tags)
[![license](https://img.shields.io/badge/license-MPL--2.0-blue)](LICENSE)

[English](README.md) · 日本語 · [简体中文](README.zh.md)

</div>

---

ルームの中の1ピアが API キーとモデルのエンドポイントを持ちます。同じルームの他の全員は、その
キーを一度も見ることなく — チャット、音声合成、音声認識を — 利用できます。リクエストはキーを
持つピアが代理で転送するからです。プロバイダは提供するサービスとモデルを広告し、コンシューマは
条件に合うものを選び、応答が途絶えたら次の候補へフェイルオーバーします。

TypeScript 製、ブラウザ向けです。トランスポートは同梱していません。
[mistlib](https://github.com/tik-choco-lab/mistlib) の wasm ノード、あるいはピアへバイトを送れる
ものなら何でも注入できます。

## 特徴

|  |  |
| --- | --- |
| **トランスポートは持ち込み** | mistlib ノード、コラボレーションルーム、送受信できるものなら何でも。メッシュライブラリは同梱しない |
| **チャット / TTS / STT** | 3つを1つのプロトコルで扱い、チャンク単位のストリーミングと並べ替えに対応 |
| **能力マッチング** | プロバイダがサービス・モデル・音声を広告し、コンシューマが絞り込んで選び、1回だけフェイルオーバーする |
| **OpenAI トンネル** | OpenAI 互換エンドポイントをルーム越しに中継。チャットプロトコルが表現できない機能もそのまま使える |
| **キーは持ち主のもとに** | コンシューマのリクエストは資格情報を含まない。プロバイダが自分の資格情報で上流へ転送する |
| **preact UI（任意）** | ステータス表示、プロバイダパネル、共通の3タブ設定画面 |
| **持ち運べる identity** | DID 委譲チェーンにより、オリジンやデバイスをまたいで同一人物として認識される |

## 導入

npm では配布していません。GitHub から入れてください。インストール時に `prepare` スクリプトが
`dist/` をビルドします。

```json
{
  "dependencies": {
    "@tik-choco/mistai": "github:tik-choco-lab/mistai#v0.8.0"
  }
}
```

`#v0.8.0` を外すと既定ブランチを追跡します。兄弟ディレクトリでライブラリとアプリを並行開発する
場合は `"file:../mistai"` にすると変更のたびに入れ直さずに済みます。先に mistai 側で
`npm install` を一度実行し、`prepare` に `dist/` を作らせてください。

`preact` は任意の peerDependency で、`/preact` サブパスを使うときだけ必要です。

## 使い方

### メッシュノードと一緒に使う

アプリが同梱している mistlib ラッパーの `MistNode` を注入します。コンシューマ側:

```ts
import { ConsumerClient } from '@tik-choco/mistai'
import { MistNode } from '../vendor/mistlib/wrappers/web/index.js'

export const llmClient = new ConsumerClient({
  createNode: (id) => new MistNode(id),
  nodeIdStorageKey: 'my-app:node-id', // 任意: アプリが既に永続化しているキーを再利用する
})

const reply = await llmClient.requestChat(roomId, messages, { model, onDelta })
const audio = await llmClient.requestTts(roomId, { text, model, voice })
const text  = await llmClient.requestStt(roomId, { audio: blob, model, fileName })
```

プロバイダ側（preact）:

```ts
import { streamChatCompletion } from '@tik-choco/mistai'
import { useNetworkProvider } from '@tik-choco/mistai/preact'
import { MistNode } from '../vendor/mistlib/wrappers/web/index.js'

const provider = useNetworkProvider({
  enabled: settings.networkProviderEnabled,
  roomId: settings.roomId,
  createNode: (id) => new MistNode(id),
  callLlm: (messages, model, onDelta) =>
    streamChatCompletion(
      { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: model ?? settings.model },
      messages,
      onDelta,
    ),
  synthesize: async (text, model, voice) => ({ blob: await ttsUpstream(text, model, voice), mime: 'audio/mpeg' }),
  transcribe: (audio, mime, model, fileName) => sttUpstream(audio, model, fileName),
  advertisedModels: models, // provider_hello.models として公開される
})
```

どのサービスを広告するかは、どの上流関数を渡したかで決まります。`synthesize` を省けば、TTS
リクエストはタイムアウトを待たずに `unsupported_service` で拒否されます。

### 別のトランスポートで使う

下層のサービスは送信関数だけを受け取るので、メッシュノードは一切関与しません。

```ts
import { ConsumerService, ProviderService, decode, encode } from '@tik-choco/mistai'

// 送信: 自前のトランスポートにメッセージを載せる
const consumer = new ConsumerService((toId, msg) => room.sendTo(toId, encode(msg)))
const provider = new ProviderService((toId, msg) => room.sendTo(toId, encode(msg)), callLlm)

// 受信: トランスポートから来たバイト列を decode して振り分ける
room.onMessage((fromId, bytes) => {
  const msg = decode(bytes)
  if (!msg) return
  consumer.handleMessage(msg)
  void provider.handleMessage(fromId, msg)
})
```

## API

| import | 内容 |
| --- | --- |
| `@tik-choco/mistai` | プロトコル、consumer/provider サービス、音声、OpenAI クライアント、トンネル、ノードファサード |
| `@tik-choco/mistai/preact` | フック、ステータス・ログのコンポーネント、共通設定画面 |
| `@tik-choco/mistai/llm-config` | localStorage 上のアプリ横断 LLM 設定 |
| `@tik-choco/mistai/identity` | DID 委譲チェーン |

一覧は [`docs/api.md`](docs/api.md) にあります。

## 多言語化

既定のメッセージは英語ですが、このライブラリがローカルで発生させる失敗はすべて安定した `code`
を持つ `MistaiError` です。英語の文面を照合するのではなく、`code` を対応付けて翻訳してください。

```ts
import { MESSAGES_JA, formatMistaiError, formatMistaiCode } from '@tik-choco/mistai'

label = MESSAGES_JA.consumerPhase[status.phase]

try {
  await llmClient.requestChat(roomId, messages)
} catch (err) {
  showToast(formatMistaiError(err, MESSAGES_JA, 'リクエストに失敗しました。'))
}
```

`MESSAGES_EN` / `MESSAGES_JA` には、コンシューマのライフサイクル、プロバイダの状態、リクエスト
ログの定訳と、エラーコードごとのメッセージが入っています。他の言語は自前の `MistaiMessages` を
渡してください。`errors` レコードは `MistaiErrorCode` を網羅するので、翻訳漏れは型エラーになります。

ひとつだけ翻訳できないものがあります。リモートピアから中継されたエラーはコード `REMOTE_ERROR`
を持ち、その文面は相手のプロバイダがそれぞれの言語で書いたものです。

## プロトコル

`v: 1` のワイヤフォーマット上の15種類のメッセージです。このライブラリの抽出元となった実装と
ワイヤ互換なので、新旧のクライアントが同じルームに同居できます。`decode()` は何も信用せず、
壊れたものにはすべて `null` を返します。

- [`docs/protocol.md`](docs/protocol.md) — メッセージ一覧、OpenAI トンネル、トランスポートの
  注入、1つのノード上で複数スタックを動かす方法
- [`docs/identity.md`](docs/identity.md) — DID 委譲チェーン

## ステータス

同じファミリーの複数のブラウザアプリで使われていますが、API は固まっていません。マイナー
バージョンでも変わります。npm では配布しておらず、git タグから入れてください。OpenAI トンネルは
v1 ではストリーミングしません。プロバイダが非ストリーミングの上流呼び出しに解決し、応答を
まとめて中継します。

## ライセンス

[Mozilla Public License 2.0](LICENSE)

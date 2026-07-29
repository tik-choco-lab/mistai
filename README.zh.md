<div align="center">

# mistai

**在点对点房间中共享 LLM 的库 —— 一个浏览器出借模型，其他浏览器直接使用。**

[![version](https://img.shields.io/github/v/tag/tik-choco-lab/mistai?label=version&color=2f6feb)](https://github.com/tik-choco-lab/mistai/tags)
[![license](https://img.shields.io/badge/license-MPL--2.0-blue)](LICENSE)

[English](README.md) · [日本語](README.ja.md) · 简体中文

</div>

---

房间里的某一个对等端持有 API 密钥和模型端点。同一房间中的其他人无需看到该密钥，就能使用它 ——
对话、语音合成、语音识别 —— 因为请求由持有密钥的那一端代为转发。提供方会公布自己提供的服务与
模型，消费方从中挑选匹配者，并在对方失联时切换到下一个候选。

使用 TypeScript 编写，面向浏览器。传输层不随包提供：你可以注入
[mistlib](https://github.com/tik-choco-lab/mistlib) 的 wasm 节点，或任何能向对等端发送字节的
实现。

## 特性

|  |  |
| --- | --- |
| **自带传输层** | mistlib 节点、协作房间，任何能收发的实现皆可 —— 不捆绑任何网格库 |
| **对话 / TTS / STT** | 三者共用一套协议，支持分块流式传输与乱序重排 |
| **能力匹配** | 提供方公布服务、模型与音色；消费方筛选、挑选，并进行一次故障切换 |
| **OpenAI 隧道** | 通过房间代理任意 OpenAI 兼容端点，让对话协议无法表达的功能也能使用 |
| **密钥不出门** | 消费方的请求不携带凭据；由提供方用自己的凭据转发到上游 |
| **可选的 preact UI** | 状态指示器、提供方面板，以及共用的三标签设置界面 |
| **可携带的身份** | DID 委派链让同一个人在不同来源与设备上被识别为同一身份 |

## 安装

未发布到 npm，请从 GitHub 安装 —— 安装过程中 `prepare` 脚本会构建 `dist/`：

```json
{
  "dependencies": {
    "@tik-choco/mistai": "github:tik-choco-lab/mistai#v0.8.0"
  }
}
```

去掉 `#v0.8.0` 则跟随默认分支。若要在同级目录中同时开发库与应用，用 `"file:../mistai"` 可以免去
每次改动后的重新安装 —— 请先在 mistai 目录里执行一次 `npm install`，让 `prepare` 生成 `dist/`。

`preact` 是可选的 peerDependency，仅在使用 `/preact` 子路径时需要。

## 用法

### 配合网格节点

注入应用自带的 mistlib 包装器中的 `MistNode`。消费方：

```ts
import { ConsumerClient } from '@tik-choco/mistai'
import { MistNode } from '../vendor/mistlib/wrappers/web/index.js'

export const llmClient = new ConsumerClient({
  createNode: (id) => new MistNode(id),
  nodeIdStorageKey: 'my-app:node-id', // 可选：复用应用已持久化的键
})

const reply = await llmClient.requestChat(roomId, messages, { model, onDelta })
const audio = await llmClient.requestTts(roomId, { text, model, voice })
const text  = await llmClient.requestStt(roomId, { audio: blob, model, fileName })
```

提供方（preact）：

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
  advertisedModels: models, // 作为 provider_hello.models 公布
})
```

公布哪些服务，取决于你传入了哪些上游函数。省略 `synthesize`，TTS 请求就会立即以
`unsupported_service` 被拒绝，而不是等到超时。

### 与其他传输层配合

底层的服务只接收一个发送函数，因此完全不涉及网格节点：

```ts
import { ConsumerService, ProviderService, decode, encode } from '@tik-choco/mistai'

// 发送：把消息交给你自己的传输层
const consumer = new ConsumerService((toId, msg) => room.sendTo(toId, encode(msg)))
const provider = new ProviderService((toId, msg) => room.sendTo(toId, encode(msg)), callLlm)

// 接收：解码来自传输层的字节并分发
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
| `@tik-choco/mistai` | 协议、消费方/提供方服务、语音、OpenAI 客户端、隧道、节点门面 |
| `@tik-choco/mistai/preact` | 钩子、状态与日志组件、共用设置界面 |
| `@tik-choco/mistai/llm-config` | localStorage 中跨应用共享的 LLM 配置 |
| `@tik-choco/mistai/identity` | DID 委派链 |

完整清单见 [`docs/api.md`](docs/api.md)。

## 本地化

默认消息为英文，但本库在本地产生的每一个失败都是带稳定 `code` 的 `MistaiError`。请通过映射
`code` 来本地化，而不要去匹配英文文本。

```ts
import { MESSAGES_JA, formatMistaiError, formatMistaiCode } from '@tik-choco/mistai'

label = MESSAGES_JA.consumerPhase[status.phase]

try {
  await llmClient.requestChat(roomId, messages)
} catch (err) {
  showToast(formatMistaiError(err, MESSAGES_JA, '请求失败。'))
}
```

`MESSAGES_EN` 与 `MESSAGES_JA` 提供了消费方生命周期、提供方状态与请求日志的标准措辞，以及每个
错误码对应的一条消息。其他语言请自行提供 `MistaiMessages`：`errors` 记录对 `MistaiErrorCode`
是穷尽的，因此漏译会成为类型错误。

有一项无法本地化：由远端对等端中继而来的错误其代码为 `REMOTE_ERROR`，文本由那一端的提供方以其
自身运行的语言写成。

## 协议

`v: 1` 线路格式上的 15 种消息，与本库所抽取自的实现保持线路兼容，因此新旧客户端可以共处同一
房间。`decode()` 不信任任何输入，遇到格式错误一律返回 `null`。

- [`docs/protocol.md`](docs/protocol.md) —— 消息清单、OpenAI 隧道、传输层注入，以及在单个节点上
  运行多套栈
- [`docs/identity.md`](docs/identity.md) —— DID 委派链

## 状态

已在同一系列的多个浏览器应用中使用，但 API 尚未冻结 —— 次版本仍会改动它。未发布到 npm，请从
git 标签安装。OpenAI 隧道在 v1 中不支持流式：提供方会解析为一次非流式的上游调用，并一次性中继
响应。

## 许可

[Mozilla Public License 2.0](LICENSE)

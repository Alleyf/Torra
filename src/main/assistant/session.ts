/**
 * 助手会话运行时：把 provider、工具、系统提示词、会话存储组装成一个可对话的东西。
 *
 * 三个必须记住的坑，代码里都做了对应处理：
 *
 * 1. **传了自定义 resourceLoader，createAgentSession 就不会再 reload 它**。
 *    不 reload 的话 getSystemPrompt() 返回 undefined，模型会用 pi 自带的编码助手人设 ——
 *    表现为「助手自称编程助手、拒绝回答 Torra 的配置问题」，而且没有任何报错。
 *    所以下面显式 `await loader.reload()`。
 *
 * 2. **显式 tools 白名单会连自定义工具一起过滤**。
 *    传了 tools 数组却没把 torra_* 名字列进去，工具就静默不注册。
 *    所以白名单直接取自 buildAssistantTools 构造出来的那批定义（含按开关追加的自建工具），
 *    不另抄一份名单 —— 抄来的名单会随着工具增删漏项，而漏项不报错。
 *
 * 3. **会话落在 userData 而不是 ~/.pi/agent/sessions**。桌面单用户应用要能续聊，
 *    但不能把用户的应用数据写进 CLI 的目录；SessionManager 的 cwd 必须由我们显式给，
 *    createAgentSession 不会回填。所有会话存在同一个目录里（assistantSessionDir）：
 *    SessionManager.list() 不递归，分作用域存的话历史会话列表就列不全。
 *
 * 4. **技能/扩展开关默认关，开了还要补白名单**。扩展是 JS 代码，直接跑在主进程里，
 *    绕开确认卡片那套写操作闸门 —— 所以只有用户在设置页明确打开才会加载；
 *    加载之后它的工具名必须补进坑 2 的白名单，否则装了也调不到，且没有任何提示。
 *
 * 5. **技能要可见，白名单里得有 read**。pi 只在活跃工具集含内置 read 时才把
 *    <available_skills> 拼进系统提示词，缺了它，导入的 SKILL.md 只会出现在设置页的
 *    「已加载」列表里，模型一个字都看不到 —— 不报错的哑火。所以开了扩展就补 read，
 *    同时挂上 plugin-host 的内联扩展，把 read 限死在技能目录内（详见 plugin-host.ts）。
 */

import path from 'node:path'
import type { AgentSession, ModelRuntime, ResourceLoader } from '@earendil-works/pi-coding-agent'
import type {
  AssistantHistoryItem,
  AssistantSessionStats,
  AssistantStreamEvent,
  AssistantToolGroup,
  AssistantTurnStats,
} from '../../shared/assistant'
import { ASSISTANT_SYSTEM_PROMPT, SELF_AUTHORING_PROMPT } from './prompt'
import { applyModelKey } from './provider'
import { capabilityHost } from './plugin-host'
import { pluginsDirOf, type InvalidPlugin, type PluginView } from './plugins'
import { friendlyError } from './errors'
import { classifyTool, messagesToHistory, TurnRecorder } from './recorder'
import { buildAssistantTools, type AssistantCaps } from './tools'
import { loadPiSdk } from './pi-sdk'

type PiModel = NonNullable<ReturnType<ModelRuntime['getModel']>>

/** 会话定位：续聊最近一场 / 新开一场 / 打开指定文件 */
export type SessionTarget = { file?: string; fresh?: boolean }

/** 已加载的技能、扩展与插件清单，给设置页和助手面板看 */
export interface LoadedCapabilities {
  skills: Array<{ name: string; description?: string; path: string }>
  extensions: Array<{ name: string; tools: string[]; path: string }>
  /** 声明式插件：开不开扩展开关都在，因为它们只是数据，执行时过确认卡片 */
  plugins: PluginView[]
  errors: Array<{ path: string; error: string }>
  /** 加载目录：开关打开后用户要知道往哪儿放文件 */
  dirs: { skills: string; extensions: string; plugins: string }
}

export interface AssistantDeps {
  /** Torra 的数据目录（userData/torra），会话与 pi 配置都落在它下面 */
  dataDir: string
  /** 打开哪场会话；不给就是接最近的一场 */
  session?: SessionTarget
  /**
   * 是否加载用户放进 Torra 私有目录的 skills / extensions。
   * 默认关：扩展是 JS 代码，直接在主进程里跑，绕开了确认卡片那道闸门。
   */
  extensions?: boolean
  caps: AssistantCaps
  runtime: ModelRuntime
  model: PiModel
  /** 流式事件出口，通常是 webContents.send 的包装 */
  emit: (event: AssistantStreamEvent) => void
  /**
   * 人在 / 浮层里亲手授权的读取目录。
   *
   * read 的闸门默认只放行 Torra 技能目录，加进来的每一条都对应一次明确的用户动作，
   * 所以它只在这场会话期间存在（不写盘、重启不复活）—— 授权的作用域一旦跨过会话，
   * 「我上次给哪个目录开过口子」就再也没人记得住。
   */
  readDirs?: string[]
}

/** 结构等价于 pi 的 ImageContent：base64（不含 data: 前缀）+ MIME，交给 prompt 的 images 通道 */
export interface AssistantImage {
  type: 'image'
  mimeType: string
  data: string
}

export interface Assistant {
  sessionId: string
  sessionFile: string | undefined
  /** 当前实际在用的模型 id；useModel 之后会跟着变 */
  readonly modelId: string
  /** 发起一轮对话；返回时该轮已彻底结束（含重试与压缩）。images 走 pi 的多模态通道 */
  send(text: string, images?: AssistantImage[]): Promise<void>
  /** 往正在进行的回合里插话 */
  steer(text: string): Promise<void>
  abort(): Promise<void>
  /** 换模型：先注入新模型的 Key，再让会话换 Model 句柄 */
  useModel(modelId: string, apiKey: string): Promise<void>
  history(): AssistantHistoryItem[]
  /** 整场会话的累计账 + 上下文占用 */
  stats(): AssistantSessionStats
  capabilities(): LoadedCapabilities
  isStreaming(): boolean
  /** 实际生效的系统提示词（组装是否正确的人眼检查口，也是回归断言点） */
  systemPromptText(): string
  /** 当前注册的工具名：白名单漏项时这里会短一截 */
  activeTools(): string[]
  dispose(): void
}

/** 工具结果给渲染层看的摘要长度上限 */
const EXCERPT_MAX = 400

function excerptOf(result: unknown): string {
  const content = (result as { content?: unknown })?.content
  if (!Array.isArray(content)) return ''
  const joined = content
    .map((c) => (typeof (c as { text?: unknown })?.text === 'string' ? (c as { text: string }).text : ''))
    .join(' ')
    .trim()
  return joined.length > EXCERPT_MAX ? `${joined.slice(0, EXCERPT_MAX)}…` : joined
}

/** 会话文件统一放在一个目录下：历史会话列表要能一次列全，分作用域存就列不到 */
export function assistantSessionDir(dataDir: string): string {
  return path.join(dataDir, 'assistant-sessions')
}

/** 技能加载目录：pi 的 agentDir 下的 skills，技能管理的导入目标就是这里 */
export function assistantSkillsDir(dataDir: string): string {
  return path.join(dataDir, 'pi', 'skills')
}

/**
 * 组装助手。调用前必须已经把当前模型的 Key 注入 runtime（provider.applyModelKey），
 * 否则第一轮请求会在运行时才报「provider not configured」。
 */
export async function createAssistant(deps: AssistantDeps): Promise<Assistant> {
  const sdk = await loadPiSdk()
  const cwd = deps.dataDir
  const piDir = path.join(deps.dataDir, 'pi')
  const withExtensions = deps.extensions === true
  /** 人授权的读取目录：先归一化，闸门和白名单用的是同一份 */
  const readDirs = (deps.readDirs ?? []).map((d) => path.resolve(d)).filter(Boolean)

  const tools = await buildAssistantTools(deps.caps)
  // 自建工具的那段纪律只在开关打开时才拼进去：提示词里提一个没注册的工具，
  // 模型就会去调它，然后收到一个「工具不存在」——最难查的那种幻觉。
  const systemPrompt = deps.caps.selfAuthoring?.()
    ? `${ASSISTANT_SYSTEM_PROMPT}\n${SELF_AUTHORING_PROMPT}`
    : ASSISTANT_SYSTEM_PROMPT

  const settingsManager = sdk.SettingsManager.inMemory({})
  const skillsDir = assistantSkillsDir(deps.dataDir)
  const pluginsDir = pluginsDirOf(deps.dataDir)
  /** 宿主加载插件的结果：工厂在 loader.reload() 里跑，所以下面就能读到 */
  let hostPlugins: PluginView[] = []
  let hostInvalid: InvalidPlugin[] = []
  // 默认全关资源加载：助手的知识与能力都来自工具，不需要（也不应该）读到项目里
  // 任何 AGENTS.md / skills / prompts —— 那是 CLI 用户的扩展面，混进来会让助手行为不可预测。
  // 打开时也只认 Torra 私有目录：cwd 是 userData、agentDir 是 userData/pi，
  // 两处都指不到源码仓库，所以不存在「顺手加载了别人项目里的扩展」。
  const loader: ResourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir: piDir,
    settingsManager,
    noExtensions: !withExtensions,
    noSkills: !withExtensions,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: !withExtensions,
    systemPrompt,
    // 内联扩展不受 noExtensions 影响（见 resource-loader 的 loadCurrentExtensionSet），
    // 所以 read 的闸门在开关关着时也在位
    extensionFactories: [
      capabilityHost({
        readRoots: [skillsDir, ...readDirs],
        cwd,
        pluginsDir,
        approve: deps.caps.approve,
        secrets: (ref) => deps.caps.pluginSecret?.(ref) ?? null,
        onPlugins: (p, invalid) => {
          hostPlugins = p
          hostInvalid = invalid
        },
        log: (text) => deps.caps.log({ stage: 'assistant', subject: 'plugin-host', ok: true, detail: text }),
      }),
    ],
  })
  await loader.reload()

  const ext = loader.getExtensions()
  const skillResult = loader.getSkills()
  // Torra 自己注入的宿主不是用户装的扩展，出现在「已加载」列表里只会让人以为
  // 多了个来路不明的东西；但它的工具名照样要进白名单，所以只在这里过滤展示
  const userExtensions = ext.extensions.filter((e) => !String(e.path ?? '').startsWith('<inline:'))
  const loadedCaps: LoadedCapabilities = {
    skills: skillResult.skills.map((s) => ({ name: s.name, description: s.description, path: s.filePath })),
    extensions: userExtensions.map((e) => ({
      name: path.basename(String(e.path ?? '')),
      tools: [...e.tools.keys()],
      path: String(e.path ?? ''),
    })),
    plugins: hostPlugins,
    errors: [
      ...ext.errors.map((e) => ({ path: String(e.path ?? ''), error: String(e.error ?? '') })),
      ...(skillResult.diagnostics ?? []).map((d) => ({
        path: String((d as { path?: unknown })?.path ?? ''),
        error: String((d as { message?: unknown })?.message ?? ''),
      })),
      ...hostInvalid.map((e) => ({ path: e.file, error: e.errors.join('；') })),
    ],
    dirs: { skills: skillsDir, extensions: path.join(piDir, 'extensions'), plugins: pluginsDir },
  }

  // 显式白名单会连扩展注册的工具一起过滤（见文件头的坑 2），所以开了扩展之后
  // 必须把它们的工具名一起加进来 —— 不加就是「装了但用不了」，而且不报错。
  // read 是给技能用的唯一入口（坑 5），它被 plugin-host 限在技能目录里。
  // 插件工具名来自宿主扩展的 tools 映射，和第三方扩展走同一条路。
  // Torra 自己的工具名直接取自已构造出来的那批定义，不另抄一份名单：
  // 抄一份就会漏一项，而漏掉的那一项表现是「模型说它没有这个工具」。
  const allowedTools = [
    ...tools.map((t) => t.name),
    // read 的两个来路：技能要读自己的 SKILL.md（开扩展），人授权的目录要读内容。
    // 后者即使扩展关着也要给 —— 人在浮层里亲手选了目录，「不给读」不可能是他要的。
    ...(withExtensions || readDirs.length > 0 ? ['read'] : []),
    ...ext.extensions.flatMap((e) => [...e.tools.keys()]),
  ]

  const sessionDir = assistantSessionDir(deps.dataDir)
  const target = deps.session?.file
    ? sdk.SessionManager.open(deps.session.file, sessionDir)
    : deps.session?.fresh
      ? sdk.SessionManager.create(cwd, sessionDir)
      : sdk.SessionManager.continueRecent(cwd, sessionDir)

  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir: piDir,
    modelRuntime: deps.runtime,
    model: deps.model,
    resourceLoader: loader,
    sessionManager: target,
    settingsManager,
    customTools: tools,
    tools: allowedTools,
  })

  let disposed = false
  let currentModel = deps.model.id
  /**
   * 本轮最后一次「请求失败」的原文。
   *
   * pi 把 404/key 失效这类错误写成一条 stopReason='error' 的 assistant 消息，
   * 然后正常 settle —— prompt() 不抛错、也没有专门的事件，于是界面上什么都不出现，
   * 用户只看到「发了消息没响应」。这里先攒着，回合结束时若始终没等到成功的
   * 回复再吐给界面；能自动重试的错误会在重试成功时被清掉，不会留下假警报。
   */
  let turnError: string | undefined
  const recorder = new TurnRecorder(deps.model.name ?? deps.model.id)
  /** 最近一轮的账：settled 之后一直留着，渲染层重开面板也问得到 */
  let lastTurn: AssistantTurnStats | undefined

  const groupOf = (name: string, args?: unknown): AssistantToolGroup => classifyTool(name, args)

  session.subscribe((event) => {
    switch (event.type) {
      case 'message_update': {
        const a = event.assistantMessageEvent
        if (a.type === 'text_delta') {
          recorder.noteText()
          deps.emit({ kind: 'text', delta: a.delta })
        } else if (a.type === 'thinking_delta') {
          deps.emit({ kind: 'thinking', delta: a.delta })
        }
        break
      }
      case 'message_end': {
        const m = event.message as {
          role?: string
          stopReason?: string
          errorMessage?: string
          usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }
          responseModel?: string
          model?: string
        }
        if (m?.role !== 'assistant') break
        recorder.addUsage(m.usage)
        recorder.noteModel(m.responseModel ?? m.model)
        if (m.stopReason === 'error') {
          turnError = m.errorMessage || '模型没有返回内容（请求失败）'
        } else {
          turnError = undefined
        }
        break
      }
      case 'tool_execution_start': {
        const group = groupOf(event.toolName, event.args)
        recorder.noteTool(group)
        deps.emit({
          kind: 'tool-start',
          id: event.toolCallId,
          name: event.toolName,
          label: session.getToolDefinition(event.toolName)?.label ?? event.toolName,
          args: event.args,
          group,
        })
        break
      }
      case 'tool_execution_end':
        deps.emit({
          kind: 'tool-end',
          id: event.toolCallId,
          name: event.toolName,
          ok: !event.isError,
          excerpt: excerptOf(event.result),
          group: groupOf(event.toolName),
        })
        break
      case 'agent_start':
        turnError = undefined
        recorder.begin()
        break
      case 'auto_retry_start':
        deps.emit({ kind: 'status', text: `模型连接异常，正在重试（第 ${event.attempt}/${event.maxAttempts} 次）` })
        break
      case 'compaction_start':
        deps.emit({ kind: 'status', text: '上下文接近上限，正在压缩历史' })
        break
      case 'agent_settled': {
        // 用 agent_settled 而不是 agent_end：前者保证重试/压缩/排队都处理完才通知，
        // 订阅 agent_end 会在「还会重试」的中间态上提前收尾，UI 的忙碌态随之错位。
        if (turnError) {
          deps.emit({ kind: 'error', text: friendlyError(turnError), detail: turnError.slice(0, 600) })
          turnError = undefined
        }
        // 统计排在 settled 之前：渲染层在 settled 里收忙碌态，之后不再有待渲染的东西
        const ctx = session.getContextUsage()
        lastTurn = recorder.finish({ contextTokens: ctx?.tokens ?? null, contextWindow: ctx?.contextWindow })
        deps.emit({ kind: 'turn-stats', stats: lastTurn })
        deps.emit({ kind: 'settled' })
        break
      }
      default:
        break
    }
  })

  return {
    sessionId: target.getSessionId(),
    sessionFile: target.getSessionFile(),
    get modelId() {
      return currentModel
    },
    async send(text, images) {
      if (disposed) throw new Error('助手会话已关闭')
      turnError = undefined
      // prompt() 之前先起表：TTFT 的起点是「用户按下发送」，不是「模型开始返回」。
      // agent_start 也会 begin，那次只是覆盖（两者相差几毫秒，重试时才重新计时）。
      recorder.begin()
      try {
        await session.prompt(text, images && images.length ? { images } : undefined)
      } catch (e) {
        // prompt 抛错时不会有 agent_settled 事件，必须自己补一个收尾，
        // 否则渲染层的忙碌态永远转下去。
        // 这里只补 settled、不推 error 事件：抛出的错由 bridge 的返回值带回渲染层，
        // 两边都报会出现两条一模一样的红字。
        turnError = undefined
        deps.emit({ kind: 'settled' })
        throw e
      }
    },
    async steer(text) {
      await session.steer(text)
    },
    async abort() {
      await session.abort()
    },
    async useModel(modelId, apiKey) {
      // 每个 Torra 模型独占一个 pi provider，Key 也随之隔离（见 provider.ts）
      const model = await applyModelKey(deps.runtime, modelId, apiKey)
      await session.setModel(model)
      currentModel = modelId
      recorder.noteModel(model.name ?? model.id)
    },
    history: () => messagesToHistory(session.messages),
    stats(): AssistantSessionStats {
      const s = session.getSessionStats()
      const ctx = session.getContextUsage()
      return {
        sessionId: s.sessionId,
        sessionName: target.getSessionName(),
        sessionFile: s.sessionFile,
        userMessages: s.userMessages,
        assistantMessages: s.assistantMessages,
        toolCalls: s.toolCalls,
        totalMessages: s.totalMessages,
        tokens: s.tokens,
        cost: s.cost,
        contextTokens: ctx?.tokens ?? null,
        contextWindow: ctx?.contextWindow ?? 0,
        contextPercent: ctx?.percent ?? null,
        ...(lastTurn ? { lastTurn } : {}),
      }
    },
    capabilities: () => loadedCaps,
    isStreaming: () => session.isStreaming,
    // 直接把组装结果暴露出来：这两个值是「没报错但行为不对」的唯一证据
    systemPromptText: () => session.systemPrompt,
    activeTools: () => session.getActiveToolNames(),
    dispose() {
      if (disposed) return
      disposed = true
      session.dispose()
    },
  }
}

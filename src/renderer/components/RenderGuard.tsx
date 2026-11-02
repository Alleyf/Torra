/**
 * 渲染层的兜底。
 *
 * 没有它的时候，任何一个 useEffect 抛错，React 会把整棵 #root 卸掉 —— 用户看到的不是
 * 「哪里错了」，而是「应用没了」，连重新进来的入口都得靠外部脚本去诊断。
 * 这里只做三件事：把异常归一成一行话、留在原地上重试、重试不奏效就转向重新载入。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { crashLine, isRapidCrash, noteCrash, type CrashState } from '../renderError'

interface Props {
  children: ReactNode
}

interface State {
  failed: boolean
  line: string
  rapid: boolean
}

const HEALTHY: State = { failed: false, line: '', rapid: false }

export class RenderGuard extends Component<Props, State> {
  state: State = HEALTHY
  /** 上一次崩溃的时间和连续次数：跨重试累计，重试成功很久以后再崩就从头计 */
  private last: CrashState | null = null

  // 先把这一支切到回退分支，具体文案等 componentDidCatch 归一好再填
  static getDerivedStateFromError(): Pick<State, 'failed'> {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // 控制台留全量堆栈：界面只摆一行，细节靠这里给 CDP 和 doctor 捞
    console.error('[torra] 渲染层抛错', error, info.componentStack)
    const next = noteCrash(this.last, Date.now())
    this.last = next
    this.setState({ line: crashLine(error), rapid: isRapidCrash(next) })
  }

  private retry = (): void => {
    this.setState(HEALTHY)
  }

  render(): ReactNode {
    const { failed, line, rapid } = this.state
    if (!failed) return this.props.children
    return (
      <div className="render-guard" role="alert">
        <strong>这一屏没画出来</strong>
        {/*
          * 主句只说人话：崩了不是用户的错，下一步是重试还是重载。
          * 真正出错的那一行（多半是英文异常）挪到下面当小字 —— 报障时要靠它定位，
          * 但它不该占主位，用户看不懂它。
          */}
        <p className="rg-line">
          Torra 在画这一屏的时候崩了，通常是某处数据形状对不上，不是你操作错了。
          先试「重试这一屏」；连着崩就「重新载入应用」。
        </p>
        {line && <p className="rg-detail" title={line}>{line}</p>}
        <div className="rg-actions">
          <button className="btn" onClick={this.retry}>重试这一屏</button>
          <button className="btn primary" onClick={() => window.location.reload()}>重新载入应用</button>
        </div>
        {rapid && (
          <p className="rg-hint muted">
            隔几秒就崩一次，重试大概率没用。重新载入应用；要是每次起来都这样，请把上面那行小字原样发给开发者。
          </p>
        )}
      </div>
    )
  }
}

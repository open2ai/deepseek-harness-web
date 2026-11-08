// 工作区领域服务（宿主侧）：把原来散在 extension.ts 里的工作区编排收口到这里。
//
// 依赖一律注入（`WorkspaceDeps`），本文件不 import extension.ts / titlebar / webview，
// 也不直接 import DshService —— 传输层由调用方注入窄接口，避免循环依赖。
import { basename } from 'node:path'
import type { WorkspaceSessionRow } from './sessions'

/** 「未分组」伪工作区 id：会话不属于任何工作区时归到这里。 */
export const UNGROUPED_ID = '__ungrouped__'
export const UNGROUPED_NAME = '未分组'

/** `workspace.list` 的一项（插件用到的字段）。 */
export interface WorkspaceInfo {
    workspaceId: string
    path: string
    title: string
    sessionIds: string[]
}


/** 传输层窄接口：只声明工作区服务真正调用的方法。 */
export interface WorkspaceDsh {
    listWorkspaces(): Promise<{ items?: WorkspaceInfo[]; archivedSessionIds?: string[] }>
    listWorkspaceSessions(workspaceId: string): Promise<WorkspaceSessionRow[]>
    listUngroupedSessions(): Promise<WorkspaceSessionRow[]>
    newSession(workspaceId: string): Promise<string>
    setCurrentWorkspace(workspaceId: string | undefined): void
    restoreSession(sessionId: string): Promise<Array<{ role?: string; text?: string; provider?: string; model?: string }>>
    bindSessionToWorkspace(workspaceId: string, sessionId: string): Promise<boolean>
    createWorkspace(path: string): Promise<{ workspace: { workspaceId: string; title?: string } }>
    ensureRunning(): Promise<boolean>
    ensureCurrentWorkspace(): Promise<unknown>
}

/** 宿主能力（VS Code / 聊天面板 / 日志）注入。 */
export interface WorkspaceDeps {
    dsh: WorkspaceDsh
    /** 确保聊天 webview 存在；成功返回目标句柄（供 waitReady 用）。 */
    ensureChat(): Promise<unknown | undefined>
    /** 聊天页面是否已就绪。 */
    waitChatReady(target: unknown): Promise<boolean>
    postBusy(kind: 'loading' | null): void
    postClear(): void
    /** 通知所有聊天视图重新取 chatInfo。 */
    postChatInfoAll(): void
    showInfo(message: string): void
    showError(message: string): void
    pickFolder(): Promise<string | undefined>
    warn(message: string): void
    /** 是否打印 restore 历史诊断（DSH_RAWLOG）。 */
    rawLog(): boolean
}

/** 工作区服务：只做编排，不碰 UI。 */
export class WorkspaceService {
    constructor(private readonly deps: WorkspaceDeps) {}

    /** UI 展示名：title 优先，缺省用路径末级。 */
    displayName(w: { path: string; title: string }): string {
        return w.title || basename(w.path)
    }

    /** 全部工作区，原样保留 `workspace.list` 的顺序。 */
    async listAll(): Promise<WorkspaceInfo[]> {
        return (await this.deps.dsh.listWorkspaces()).items ?? []
    }

    /** 某工作区会话；未分组走另一条判据。 */
    async listSessionsOf(workspaceId: string): Promise<WorkspaceSessionRow[]> {
        return workspaceId === UNGROUPED_ID
            ? this.deps.dsh.listUngroupedSessions()
            : this.deps.dsh.listWorkspaceSessions(workspaceId)
    }

    /** 切到工作区并开新会话。自己兜错、返回成败，不向外抛。 */
    async switchNew(workspaceId: string): Promise<boolean> {
        try {
            if ((await this.deps.ensureChat()) === undefined) {
                throw new Error('聊天视图未就绪，请先打开侧边栏 DSH 面板')
            }
            this.deps.dsh.setCurrentWorkspace(workspaceId)
            await this.deps.dsh.newSession(workspaceId)
            this.deps.postClear()
            this.deps.postChatInfoAll()
            this.deps.showInfo('已切换工作区')
            return true
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e)
            this.deps.warn(`[dsh-ws] 新建会话失败 ws=${workspaceId}：${message}`)
            this.deps.showError(`新建会话失败：${message}`)
            return false
        }
    }

    /** 恢复某个会话；`workspaceId=undefined` = 未分组（不设当前工作区、不补登记）。 */
    async restore(workspaceId: string | undefined, sessionId: string): Promise<void> {
        const target = await this.deps.ensureChat()
        if (target === undefined) {
            throw new Error('聊天视图未就绪，请先打开侧边栏 DSH 面板')
        }
        if (!(await this.deps.waitChatReady(target))) {
            throw new Error('聊天页面尚未就绪，请稍后重试')
        }
        if (workspaceId === undefined) {
            this.deps.dsh.setCurrentWorkspace(undefined)
        } else {
            this.deps.dsh.setCurrentWorkspace(workspaceId)
            // 从该工作区点开：若只是 cwd 一致而未登记成员表，补登记，避免网页端仍显示未分组。
            void this.deps.dsh
                .bindSessionToWorkspace(workspaceId, sessionId)
                .then((bound) => {
                    if (bound) {
                        this.deps.warn(`[dsh-ws] 会话已补登记进工作区 session=${sessionId} ws=${workspaceId}`)
                    }
                })
                .catch((e: unknown) => {
                    this.deps.warn(
                        `[dsh-ws] 会话补登记失败 session=${sessionId} ws=${workspaceId} error=${e instanceof Error ? e.message : String(e)}`
                    )
                })
        }
        this.deps.postBusy('loading')
        // 抛错也要解除 loading，否则界面永远停在「深度求索中」。
        const messages = await this.deps.dsh.restoreSession(sessionId).catch((e: unknown) => {
            this.deps.postBusy(null)
            throw e
        })
        this.deps.warn(`[dsh-restore] session=${sessionId} messages=${messages.length}`)
        if (this.deps.rawLog()) {
            for (const m of messages) {
                if (m.role !== 'assistant') continue
                console.log(
                    `[dsh-raw] history-assistant len=${m.text?.length ?? 0} provider=${m.provider ?? '-'} model=${m.model ?? '-'}`
                )
            }
        }
        this.deps.postChatInfoAll()
        this.deps.postBusy(null)
    }

    /** 弹目录选择并新建工作区；取消返回 false。 */
    async createNew(): Promise<boolean> {
        const dir = await this.deps.pickFolder()
        if (dir === undefined) return false
        const created = await this.deps.dsh.createWorkspace(dir)
        this.deps.dsh.setCurrentWorkspace(created.workspace.workspaceId)
        await this.deps.dsh.newSession(created.workspace.workspaceId)
        this.deps.postClear()
        this.deps.postChatInfoAll()
        this.deps.showInfo(`已新建并切换到工作区：${created.workspace.title || basename(dir)}`)
        return true
    }
}

/**
 * 创建服务工作区实例。
 * @param deps - 宿主注入的能力。
 * @returns 工作区服务。
 */
export function createWorkspaceService(deps: WorkspaceDeps): WorkspaceService {
    return new WorkspaceService(deps)
}
